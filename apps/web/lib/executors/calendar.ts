import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError } from "@repo/ai";
import {
  getEvents as corsairGetEvents,
  createEvent as corsairCreateEvent,
  updateEvent as corsairUpdateEvent,
  deleteEvent as corsairDeleteEvent,
} from "@repo/services/calendar/index";
import {
  linkThreadEvent,
  closeThreadLink,
  resolveWriteTarget,
  getActiveThreadMeetings,
  userOwnsEvent,
} from "@repo/services/calendar/thread-links";
import { db, eq } from "@repo/database";
import { user } from "@repo/database/schema";

const MAX_EVENT_RESULTS = 20;

/**
 * The execution context as the calendar executors actually receive it. The
 * orchestrator threads `userTimeZone` through, but `ToolExecutionContext`
 * doesn't declare it — the older executors above reach it via `as any`. New
 * code uses this instead.
 */
interface CalendarToolContext {
  userId: string;
  requestId: string;
  userTimeZone?: string;
}

async function getAuthenticatedEmail(userId: string): Promise<string> {
  const [dbUser] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!dbUser) {
    throw new Error(`User ${userId} not found`);
  }
  return dbUser.email;
}

export interface GetEventsInput {
  timeMin?: string;
  timeMax?: string;
}

export interface GetEventsOutput {
  events: Array<Record<string, unknown>>;
}

/**
 * Production executor for getEvents.
 *
 * Delegates to the existing @repo/services/calendar → getEvents() which
 * uses Corsair to query Google Calendar.
 *
 * Defaults to a 30-day window if no time bounds provided.
 * Normalizes CalendarEvent[] → output schema shape.
 * Hard limit: MAX_EVENT_RESULTS = 20.
 */
export class CorsairGetEventsExecutor
  implements ToolExecutor<GetEventsInput, GetEventsOutput>
{
  async execute(
    args: GetEventsInput,
    ctx: { userId: string; requestId: string },
  ): Promise<GetEventsOutput> {
    try {
      const now = new Date().toISOString();
      const thirtyDaysLater = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const result = await corsairGetEvents(
        ctx.userId,
        {
          timeMin: args.timeMin ?? now,
          timeMax: args.timeMax ?? thirtyDaysLater,
        },
        (ctx as any).userTimeZone,
      );

      const events = result.slice(0, MAX_EVENT_RESULTS).map((ev) => ({
        id: ev.id,
        title: ev.title,
        start: ev.start,
        end: ev.end,
        allDay: ev.allDay,
        description: ev.description,
        location: ev.location,
        attendees: ev.attendees,
      }));

      return { events };
    } catch (error) {
      throw new ToolExecutionError("getEvents", error);
    }
  }
}

// ── createEvent ──────────────────────────────────────────────────────

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  attendees?: string[];
  description?: string;
  organizer?: string;
}

export interface CreateEventOutput {
  draft: boolean;
  id?: string;
}

/**
 * Production executor for createEvent.
 *
 * Delegates to @repo/services/calendar → createEvent() which calls
 * Corsair's Google Calendar events.create().
 *
 * Returns the created event ID on success.
 */
export class CorsairCreateEventExecutor
  implements ToolExecutor<CreateEventInput, CreateEventOutput>
{
  async execute(
    args: CreateEventInput,
    ctx: { userId: string; requestId: string },
  ): Promise<CreateEventOutput> {
    console.log("[executor:createEvent] START", {
      userId: ctx.userId,
      title: args.title,
      start: args.start,
      end: args.end,
      attendees: args.attendees,
      organizer: args.organizer,
    });
    try {
      if (args.organizer) {
        const authenticatedEmail = await getAuthenticatedEmail(ctx.userId);
        if (args.organizer.toLowerCase() !== authenticatedEmail.toLowerCase()) {
          throw new Error(
            `Cannot create events on behalf of another account.`
          );
        }
      }

      const result = await corsairCreateEvent(ctx.userId, {
        title: args.title,
        start: args.start,
        end: args.end,
        allDay: false,
        attendees: args.attendees,
        description: args.description,
      }, (ctx as any).userTimeZone);

      console.log("[executor:createEvent] SUCCESS", { id: result.id, title: result.title });
      return { draft: false, id: result.id };
    } catch (error) {
      console.error("[executor:createEvent] ERROR", { error: String(error), userId: ctx.userId });
      throw new ToolExecutionError("createEvent", error);
    }
  }
}

// ── Thread-scoped meeting tools ──────────────────────────────────────
//
// These address a meeting by the thread it belongs to, never by event id.
// That is deliberate: an event id pasted into an email body is not something
// the model can express through these schemas, so the injection path is closed
// by shape rather than by a check that has to pass. The ownership verification
// below stays anyway, as defence in depth.

export interface GetThreadMeetingsInput {
  threadId: string;
}

export interface GetThreadMeetingsOutput {
  meetings: Array<{
    title: string;
    start: string;
    end: string;
    attendees: string[];
  }>;
}

/** Read-only: what has this thread already scheduled? */
export class ThreadMeetingsExecutor
  implements ToolExecutor<GetThreadMeetingsInput, GetThreadMeetingsOutput>
{
  async execute(
    args: GetThreadMeetingsInput,
    ctx: { userId: string; requestId: string },
  ): Promise<GetThreadMeetingsOutput> {
    try {
      const meetings = await getActiveThreadMeetings(ctx.userId, args.threadId);
      return {
        meetings: meetings.map((m) => ({
          title: m.title,
          start: m.start,
          end: m.end,
          attendees: m.attendees,
        })),
      };
    } catch (error) {
      throw new ToolExecutionError("getThreadMeetings", error);
    }
  }
}

export interface ScheduleThreadMeetingInput {
  threadId: string;
  title: string;
  start: string;
  end: string;
  attendees?: string[];
  description?: string;
  organizer?: string;
}

export class ScheduleThreadMeetingExecutor
  implements ToolExecutor<ScheduleThreadMeetingInput, CreateEventOutput>
{
  async execute(
    args: ScheduleThreadMeetingInput,
    ctx: CalendarToolContext,
  ): Promise<CreateEventOutput> {
    console.log("[executor:scheduleThreadMeeting] START", {
      userId: ctx.userId,
      threadId: args.threadId,
      title: args.title,
    });
    try {
      if (args.organizer) {
        const authenticatedEmail = await getAuthenticatedEmail(ctx.userId);
        if (args.organizer.toLowerCase() !== authenticatedEmail.toLowerCase()) {
          throw new Error(`Cannot create events on behalf of another account.`);
        }
      }

      const result = await corsairCreateEvent(
        ctx.userId,
        {
          title: args.title,
          start: args.start,
          end: args.end,
          allDay: false,
          attendees: args.attendees,
          description: args.description,
        },
        ctx.userTimeZone,
      );

      // Awaited, not fire-and-forget: an unlinked event is invisible to the
      // thread, so a later "move it" would create a second one instead.
      await linkThreadEvent({
        userId: ctx.userId,
        threadId: args.threadId,
        eventId: result.id,
      });

      console.log("[executor:scheduleThreadMeeting] SUCCESS", { id: result.id });
      return { draft: false, id: result.id };
    } catch (error) {
      console.error("[executor:scheduleThreadMeeting] ERROR", {
        error: String(error),
        userId: ctx.userId,
      });
      throw new ToolExecutionError("scheduleThreadMeeting", error);
    }
  }
}

export interface RescheduleThreadMeetingInput {
  threadId: string;
  start: string;
  end: string;
  title?: string;
  description?: string;
}

export class RescheduleThreadMeetingExecutor
  implements ToolExecutor<RescheduleThreadMeetingInput, CreateEventOutput>
{
  async execute(
    args: RescheduleThreadMeetingInput,
    ctx: CalendarToolContext,
  ): Promise<CreateEventOutput> {
    try {
      const target = await resolveTargetOrThrow(
        ctx.userId,
        args.threadId,
        "reschedule",
      );

      const result = await corsairUpdateEvent(
        ctx.userId,
        target.eventId,
        {
          start: args.start,
          end: args.end,
          ...(args.title ? { title: args.title } : {}),
          ...(args.description ? { description: args.description } : {}),
        },
        ctx.userTimeZone,
      );

      console.log("[executor:rescheduleThreadMeeting] SUCCESS", {
        id: result.id,
        start: args.start,
      });
      return { draft: false, id: result.id };
    } catch (error) {
      throw new ToolExecutionError("rescheduleThreadMeeting", error);
    }
  }
}

export interface CancelThreadMeetingInput {
  threadId: string;
}

export class CancelThreadMeetingExecutor
  implements ToolExecutor<CancelThreadMeetingInput, { cancelled: boolean }>
{
  async execute(
    args: CancelThreadMeetingInput,
    ctx: { userId: string; requestId: string },
  ): Promise<{ cancelled: boolean }> {
    try {
      const target = await resolveTargetOrThrow(
        ctx.userId,
        args.threadId,
        "cancel",
      );

      await corsairDeleteEvent(ctx.userId, target.eventId);
      await closeThreadLink(
        ctx.userId,
        target.calendarId,
        target.eventId,
        "CANCELLED",
      );

      console.log("[executor:cancelThreadMeeting] SUCCESS", {
        id: target.eventId,
      });
      return { cancelled: true };
    } catch (error) {
      throw new ToolExecutionError("cancelThreadMeeting", error);
    }
  }
}

// ── Approval previews ────────────────────────────────────────────────
//
// Without these the approval card renders raw tool args. That's tolerable for
// a create (the args *are* the event) and unacceptable for a reschedule, where
// the thing the user needs to check is what the meeting is moving *from* —
// which appears nowhere in the args.

function formatWhen(iso: string | undefined, timeZone?: string): string {
  if (!iso) return "(no time)";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return date.toLocaleString("en-US", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return date.toISOString();
  }
}

function describeEvent(
  args: Record<string, unknown>,
  timeZone?: string,
): string[] {
  const lines = [`Title: ${(args.title as string) ?? "(untitled)"}`];
  lines.push(
    `When: ${formatWhen(args.start as string, timeZone)} – ${formatWhen(args.end as string, timeZone)}`,
  );
  const attendees = args.attendees;
  if (Array.isArray(attendees) && attendees.length > 0) {
    lines.push(`Attendees: ${attendees.join(", ")}`);
  }
  return lines;
}

export function buildCreateEventPreview(
  args: Record<string, unknown>,
  ctx: { userId: string; userTimeZone?: string },
): string {
  return describeEvent(args, ctx.userTimeZone).join("\n");
}

/**
 * Before → after. Resolving the current meeting is the whole point: approving
 * a reschedule without seeing the time it moves away from is approving blind.
 */
export async function buildRescheduleMeetingPreview(
  args: Record<string, unknown>,
  ctx: { userId: string; userTimeZone?: string },
): Promise<string> {
  const threadId = args.threadId as string | undefined;
  if (!threadId) return "Reschedule this thread's meeting";

  try {
    const target = await resolveWriteTarget(ctx.userId, threadId);

    if (target.kind === "none") {
      return "No meeting is scheduled from this thread — nothing to reschedule.";
    }
    if (target.kind === "ambiguous") {
      const list = target.meetings
        .map((m) => `  • ${m.title} — ${formatWhen(m.start, ctx.userTimeZone)}`)
        .join("\n");
      return `This thread has ${target.meetings.length} meetings; the assistant must ask which:\n${list}`;
    }

    const before = `${formatWhen(target.meeting.start, ctx.userTimeZone)} – ${formatWhen(target.meeting.end, ctx.userTimeZone)}`;
    const after = `${formatWhen(args.start as string, ctx.userTimeZone)} – ${formatWhen(args.end as string, ctx.userTimeZone)}`;
    return [
      `Meeting: ${target.meeting.title}`,
      `Before:  ${before}`,
      `After:   ${after}`,
      target.meeting.attendees.length
        ? `Attendees notified: ${target.meeting.attendees.join(", ")}`
        : "No attendees to notify",
    ].join("\n");
  } catch (error) {
    console.error("[executor:rescheduleThreadMeeting] preview failed", {
      error: String(error),
    });
    return "Reschedule this thread's meeting (could not resolve the current time)";
  }
}

export async function buildCancelMeetingPreview(
  args: Record<string, unknown>,
  ctx: { userId: string; userTimeZone?: string },
): Promise<string> {
  const threadId = args.threadId as string | undefined;
  if (!threadId) return "Cancel this thread's meeting";

  try {
    const target = await resolveWriteTarget(ctx.userId, threadId);

    if (target.kind === "none") {
      return "No meeting is scheduled from this thread — nothing to cancel.";
    }
    if (target.kind === "ambiguous") {
      const list = target.meetings
        .map((m) => `  • ${m.title} — ${formatWhen(m.start, ctx.userTimeZone)}`)
        .join("\n");
      return `This thread has ${target.meetings.length} meetings; the assistant must ask which:\n${list}`;
    }

    return [
      `Cancel: ${target.meeting.title}`,
      `When:   ${formatWhen(target.meeting.start, ctx.userTimeZone)} – ${formatWhen(target.meeting.end, ctx.userTimeZone)}`,
      target.meeting.attendees.length
        ? `Attendees notified: ${target.meeting.attendees.join(", ")}`
        : "No attendees to notify",
    ].join("\n");
  } catch (error) {
    console.error("[executor:cancelThreadMeeting] preview failed", {
      error: String(error),
    });
    return "Cancel this thread's meeting (could not resolve which meeting)";
  }
}

/**
 * Resolve the meeting a write should act on, or explain why it can't.
 *
 * Note what is absent: there is no "pick the newest" fallback. Newest-wins is
 * fine for seeding a banner the user can see and correct; it is not fine for
 * an irreversible action approved from a card that shows only one option. With
 * more than one active meeting the model is told to ask.
 */
async function resolveTargetOrThrow(
  userId: string,
  threadId: string,
  verb: string,
): Promise<{ eventId: string; calendarId: string }> {
  const target = await resolveWriteTarget(userId, threadId);

  if (target.kind === "none") {
    throw new Error(
      `This thread has no scheduled meeting to ${verb}. Nothing was changed.`,
    );
  }

  if (target.kind === "ambiguous") {
    const list = target.meetings
      .map((m) => `"${m.title}" starting ${m.start}`)
      .join("; ");
    throw new Error(
      `This thread has ${target.meetings.length} scheduled meetings (${list}). ` +
        `Ask the user which one to ${verb} — do not guess.`,
    );
  }

  // Defence in depth: the schemas never accept an eventId, so this can only
  // fail if a link outlived the calendar it pointed at.
  if (!(await userOwnsEvent(userId, target.meeting.eventId))) {
    throw new Error("That event does not belong to this account.");
  }

  return {
    eventId: target.meeting.eventId,
    calendarId: target.meeting.calendarId,
  };
}

