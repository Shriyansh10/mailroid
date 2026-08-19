import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError } from "@repo/ai";
import {
  getEvents as corsairGetEvents,
  createEvent as corsairCreateEvent,
  updateEvent as corsairUpdateEvent,
  deleteEvent as corsairDeleteEvent,
  normalizeToUtcTimestamp,
  assertNotPast,
} from "@repo/services/calendar/index";
import { getEventStatus } from "@repo/shared/time";
import { resolveAddMeet } from "@repo/shared/calendar";
import {
  linkThreadEvent,
  closeThreadLink,
  resolveWriteTarget,
  resolveSelection,
  selectionIdFor,
  checkSelectionDrift,
  getActiveThreadMeetings,
  getUpcomingThreadMeetings,
  isUpcomingMeeting,
  userOwnsEvent,
  type ThreadMeeting,
} from "@repo/services/calendar/thread-links";
import { resolveAttendeeRefs } from "@repo/services/scheduling/contacts";
import { buildThreadSharedProperties } from "@repo/services/gmail/thread-headers";
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

/**
 * Merge literal `attendees` with resolved `attendeeRefs` into one address list.
 *
 * This is the ONLY place a contact handle becomes an email address. The model
 * cannot supply addresses — every one it has seen was masked to "[EMAIL]" —
 * so it names people by handle and the resolution happens here, server-side,
 * at the moment of writing the invite.
 *
 * An unknown handle throws rather than being skipped. Quietly dropping it
 * would send the invite to fewer people than the user agreed to, on an
 * outward-facing action — the exact silent degradation CLAUDE.md forbids.
 */
async function resolveAttendees(
  userId: string,
  attendees?: string[],
  attendeeRefs?: string[],
): Promise<string[] | undefined> {
  const literal = attendees ?? [];

  if (!attendeeRefs?.length) {
    return literal.length > 0 ? literal : undefined;
  }

  const { emails: resolved, unknown } = await resolveAttendeeRefs(userId, attendeeRefs);
  if (unknown.length > 0) {
    throw new Error(
      `Could not resolve ${unknown.length} attendee reference(s). ` +
        `Call resolveRecipient again for those people rather than scheduling without them.`,
    );
  }

  const merged = [...new Set([...literal, ...resolved])];
  return merged.length > 0 ? merged : undefined;
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

      // These start/end values are already real, offset-bearing instants
      // from Google — no naive-string handling needed for the status check.
      const eventsNow = new Date();
      const events = result.slice(0, MAX_EVENT_RESULTS).map((ev) => ({
        id: ev.id,
        title: ev.title,
        start: ev.start,
        end: ev.end,
        allDay: ev.allDay,
        description: ev.description,
        location: ev.location,
        attendees: ev.attendees,
        status: getEventStatus(ev, eventsNow),
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
  /** Contact handles from resolveRecipient; what the model actually supplies. */
  attendeeRefs?: string[];
  description?: string;
  organizer?: string;
  /** Attach a Google Meet conference. Shown on, and editable from, the approval card. */
  addMeet?: boolean;
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
      assertNotPast(args.start, (ctx as any).userTimeZone);

      if (args.organizer) {
        const authenticatedEmail = await getAuthenticatedEmail(ctx.userId);
        if (args.organizer.toLowerCase() !== authenticatedEmail.toLowerCase()) {
          throw new Error(
            `Cannot create events on behalf of another account.`
          );
        }
      }

      const attendees = await resolveAttendees(ctx.userId, args.attendees, args.attendeeRefs);

      const result = await corsairCreateEvent(ctx.userId, {
        title: args.title,
        start: args.start,
        end: args.end,
        allDay: false,
        attendees,
        description: args.description,
        // Resolved, not read literally: an omitted flag means the model never
        // decided, and the preview the user approved filled the same blank the
        // same way. See resolveAddMeet.
        addMeet: resolveAddMeet(args),
      }, (ctx as any).userTimeZone);

      console.log("[executor:createEvent] SUCCESS", {
        id: result.id,
        title: result.title,
        meetStatus: result.meetStatus,
      });
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
    /** How the model names this meeting when rescheduling or cancelling it. */
    selectionId: string;
    title: string;
    start: string;
    end: string;
    attendees: string[];
    /**
     * This meeting has already ended. It is listed because it is part of the
     * thread's history and the user may well be asking about it — but it can
     * no longer be rescheduled or cancelled, and the resolver refuses a token
     * naming one. Tagged rather than hidden so the model answers "you met on
     * the 12th" correctly instead of proposing a move that will be refused.
     */
    past: boolean;
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
        // Projected explicitly: eventId and calendarId stay server-side, and
        // selectionId is what crosses the boundary in their place.
        meetings: meetings.map((m) => ({
          selectionId: selectionIdFor(m.eventId),
          title: m.title,
          start: m.start,
          end: m.end,
          attendees: m.attendees,
          past: !isUpcomingMeeting(m),
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
  /** Contact handles from resolveRecipient; what the model actually supplies. */
  attendeeRefs?: string[];
  description?: string;
  organizer?: string;
  /** Set by the model only after the user has seen the thread's existing meetings and chosen to add another. */
  acknowledgedExistingMeetings?: boolean;
  /** Attach a Google Meet conference. Shown on, and editable from, the approval card. */
  addMeet?: boolean;
}

/**
 * Refuses to book a second meeting on a thread until the user has been asked.
 *
 * Runs BEFORE the approval card is minted (see `precheck` in
 * packages/ai/src/tools/types.ts). That placement is the point: "move the
 * existing one, or add a second, or neither" has three answers and an approval
 * card has two, so the question can only be asked in conversation — which
 * means before any card exists. Refusing at execute time would ask it after
 * the user had already approved something else.
 *
 * Cheap and idempotent, per the precheck contract: one read of links we own,
 * no writes. It deliberately runs again on the approve-side replay, and the
 * acknowledgement rides in the stored args, so an approved call passes the
 * same gate it passed the first time.
 */
export async function precheckScheduleThreadMeeting(
  args: Record<string, unknown>,
  ctx: { userId: string; userTimeZone?: string },
): Promise<string | null> {
  const threadId = args.threadId as string | undefined;
  if (!threadId) return null; // Let the schema report the missing field.

  // The user has already been shown the list and asked for another anyway.
  if (args.acknowledgedExistingMeetings === true) return null;

  // Deliberately NOT wrapped in a try/catch that returns null. If we cannot
  // tell whether this thread already has a meeting, the safe answer is to stop
  // — swallowing the error would re-open the duplicate-invite path on exactly
  // the calendar outage that makes duplicates hardest to notice.
  // Upcoming only. A meeting that already ended is history, not a conflict:
  // "schedule a meeting with John" means create one, and letting yesterday's
  // call turn that into "shall I move it?" is the bug this filter closes.
  const meetings = await getUpcomingThreadMeetings(ctx.userId, threadId);
  if (meetings.length === 0) return null;

  const noun = meetings.length === 1 ? "meeting" : "meetings";
  return [
    `This thread already has ${meetings.length} ${noun} scheduled. NOTHING was created.`,
    describeMeetings(meetings, ctx.userTimeZone),
    ``,
    `Do not choose for the user. Show them this list and ask which they want:`,
    `  (a) move an existing meeting to the new time — call rescheduleThreadMeeting with that meeting's selectionId;`,
    `  (b) keep it and add a SECOND, separate meeting — call scheduleThreadMeeting again with acknowledgedExistingMeetings: true;`,
    `  (c) neither — do nothing.`,
    meetings.length === 1
      ? `Someone asking for a different time almost always means (a).`
      : `If they choose (a), ask WHICH meeting by name and time before acting.`,
    `Calling this tool again unchanged will report the same thing.`,
  ].join("\n");
}

/**
 * Refuses a reschedule or cancel that has nothing to act on, BEFORE an approval
 * card is minted.
 *
 * Without this the flow was: model calls rescheduleThreadMeeting on a thread
 * with no meeting → orchestrator mints a card → user approves → execute throws
 * "no scheduled meeting to reschedule" → the model, holding a refusal with no
 * stated cause, tells the user the meeting "has already been cancelled". None
 * of that is true, and the user was asked to approve an action that could never
 * have succeeded. Observed on 20 Aug 2026.
 *
 * Two separate failures, one fix. Asking for approval is a promise that the
 * action is possible, and a refusal has to state its own cause or the model
 * will invent one.
 *
 * Only the two states that no argument can rescue are refused here — `none` and
 * `past-only`. `ambiguous` is deliberately allowed through: a `selectionId` may
 * name exactly one of those meetings, and the executor resolves that properly.
 *
 * Cheap and idempotent per the precheck contract: one read of links we own, no
 * writes, and it runs again on the approve-side replay.
 */
async function precheckThreadMeetingWrite(
  verb: "reschedule" | "cancel",
  args: Record<string, unknown>,
  ctx: { userId: string; userTimeZone?: string },
): Promise<string | null> {
  const threadId = args.threadId as string | undefined;
  if (!threadId) return null; // Let the schema report the missing field.

  // Deliberately not wrapped in a try/catch returning null: if we cannot tell
  // whether this thread has a meeting, the safe answer is to stop rather than
  // mint a card for an action we cannot vouch for.
  const target = await resolveWriteTarget(ctx.userId, threadId);

  if (target.kind === "none") {
    return [
      `This thread has no meeting scheduled from it, so there is nothing to ${verb}. NOTHING was changed and no approval was requested.`,
      ``,
      `Do NOT tell the user the meeting was cancelled, deleted, or removed — you do not know that, and it is usually false. What is true is narrower: no meeting on this thread is linked to it.`,
      `If they were pointing at a meeting they saw through getEvents, say plainly that it did not come from this thread, and that you can only move or cancel meetings scheduled from the thread you are reading. Offer to schedule a new one.`,
    ].join("\n");
  }

  if (target.kind === "past-only") {
    const noun = target.meetings.length === 1 ? "meeting" : "meetings";
    return [
      `This thread's ${noun} already ended, and a finished meeting cannot be ${verb === "cancel" ? "cancelled" : "moved"}. NOTHING was changed and no approval was requested.`,
      describeMeetings(target.meetings, ctx.userTimeZone),
      ``,
      `Say the meeting is over — not that it was cancelled — and offer to schedule a NEW one. Do not call this tool again for these.`,
    ].join("\n");
  }

  return null;
}

export const precheckRescheduleThreadMeeting = (
  args: Record<string, unknown>,
  ctx: { userId: string; userTimeZone?: string },
) => precheckThreadMeetingWrite("reschedule", args, ctx);

export const precheckCancelThreadMeeting = (
  args: Record<string, unknown>,
  ctx: { userId: string; userTimeZone?: string },
) => precheckThreadMeetingWrite("cancel", args, ctx);

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
      assertNotPast(args.start, ctx.userTimeZone);

      if (args.organizer) {
        const authenticatedEmail = await getAuthenticatedEmail(ctx.userId);
        if (args.organizer.toLowerCase() !== authenticatedEmail.toLowerCase()) {
          throw new Error(`Cannot create events on behalf of another account.`);
        }
      }

      const attendees = await resolveAttendees(ctx.userId, args.attendees, args.attendeeRefs);

      // Stamps the thread's root Message-ID onto the event, which is what lets
      // an invited guest find this meeting from their own copy of the thread.
      const sharedProperties = await buildThreadSharedProperties(
        ctx.userId,
        args.threadId,
      );

      const result = await corsairCreateEvent(
        ctx.userId,
        {
          title: args.title,
          start: args.start,
          end: args.end,
          allDay: false,
          attendees,
          description: args.description,
          sharedProperties,
          addMeet: resolveAddMeet(args),
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
  /** Names one of the thread's meetings; required once there is more than one. */
  selectionId?: string;
  /** Server-injected drift check — see the schema comment in registry.ts. */
  expectedStart?: string;
}

export class RescheduleThreadMeetingExecutor
  implements ToolExecutor<RescheduleThreadMeetingInput, CreateEventOutput>
{
  async execute(
    args: RescheduleThreadMeetingInput,
    ctx: CalendarToolContext,
  ): Promise<CreateEventOutput> {
    try {
      assertNotPast(args.start, ctx.userTimeZone);

      const target = await resolveTargetOrThrow(
        ctx.userId,
        args.threadId,
        "reschedule",
        args.selectionId,
        args.expectedStart,
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
  /** Names one of the thread's meetings; required once there is more than one. */
  selectionId?: string;
  /** Server-injected drift check — see the schema comment in registry.ts. */
  expectedStart?: string;
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
        args.selectionId,
        args.expectedStart,
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
  try {
    const date = new Date(normalizeToUtcTimestamp(iso, timeZone));
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString("en-US", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    // Malformed iso or an invalid IANA zone (Intl.DateTimeFormat throws on
    // a bad timeZone) must never take down the approval card — fall back to
    // the raw string rather than crashing the preview render.
    return iso;
  }
}

/**
 * Render a thread's meetings as a numbered list the model can read back to the
 * user, each tagged with the token needed to act on it.
 *
 * Titles come from Google, i.e. they are user content and can carry anything a
 * meeting organiser typed. These strings are interpolated into tool *errors*,
 * and `firewall.sanitizeToolOutput` in the agent loop only runs on the success
 * path — so newlines are stripped and the title is capped here, where the
 * untrusted value actually enters the prompt.
 */
function describeMeetings(
  meetings: ThreadMeeting[],
  timeZone?: string,
): string {
  return meetings
    .map((m, i) => {
      const title = m.title.replace(/\s+/g, " ").trim().slice(0, 80) || "(untitled)";
      return `  ${i + 1}. "${title}" — ${formatWhen(m.start, timeZone)} (selectionId: ${selectionIdFor(m.eventId)})`;
    })
    .join("\n");
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
  // Always stated, both ways. "No line" would mean the user approves a join
  // link being sent to every guest without ever having been shown that it was
  // part of what they were approving.
  lines.push(
    resolveAddMeet(args)
      ? "Google Meet: yes — a join link will be created"
      : "Google Meet: no",
  );
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
    if (target.kind === "past-only") {
      return "This thread's meeting has already ended — a finished meeting cannot be moved. Schedule a new one instead.";
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
    if (target.kind === "past-only") {
      return "This thread's meeting has already ended — there is nothing left to cancel.";
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
  selectionId?: string,
  expectedStart?: string,
): Promise<{ eventId: string; calendarId: string }> {
  // A token was supplied: it names one meeting exactly, whatever else has
  // happened to the thread since the list was shown.
  // Only the organiser can move or cancel. A guest holds a link row purely so
  // the meeting is VISIBLE to them; Google would reject the write anyway, or
  // apply it partially, and either way an attendee must not be able to move
  // everyone else's meeting.
  const refuseIfGuest = (meeting: ThreadMeeting) => {
    if (meeting.role === "GUEST") {
      throw new Error(
        `You're a guest on "${meeting.title}" — only the organiser can ${verb} it. Nothing was changed. Suggest replying on the thread to ask them instead.`,
      );
    }
  };

  if (selectionId) {
    const selected = await resolveSelection(userId, threadId, selectionId);
    if (selected.kind === "notFound") {
      throw new Error(
        selected.meetings.length === 0
          ? `That meeting is no longer on this thread — it may have been cancelled already. Nothing was changed. Tell the user rather than picking another one.`
          : `No meeting on this thread matches that selection; it was probably cancelled since you listed them. Nothing was changed. The thread now has:\n${describeMeetings(selected.meetings)}\nRe-confirm with the user which one they mean.`,
      );
    }

    // Resolves, but names a meeting that is over. Refused rather than acted
    // on: moving a finished meeting re-invites everyone to something they
    // already attended, and there is no reading of "reschedule" that wants
    // that. The model is told to offer the only useful alternative.
    if (selected.kind === "past") {
      throw new Error(
        `"${selected.meeting.title}" already ended (${formatWhen(selected.meeting.start)}). ` +
          `A finished meeting cannot be ${verb === "cancel" ? "cancelled" : "moved"}, and nothing was changed. ` +
          `Tell the user it is over and offer to schedule a NEW meeting instead — do not pick a different meeting.`,
      );
    }

    // The token survives a reschedule (it's derived from the eventId, not the
    // time), so a same-event drift check needs a SEPARATE signal:
    // expectedStart, injected server-side from the ledger of what
    // getThreadMeetings last showed this conversation (see
    // apps/web/app/api/chat/route.ts — never trust the model's own copy of
    // this value). "missing" (no ledger entry, e.g. the model acted on a
    // precheck refusal's list without a prior getThreadMeetings call) refuses
    // exactly like "changed" — a hole in the safety record is not "nothing to
    // check", it's its own failure mode. See checkSelectionDrift.
    const drift = checkSelectionDrift(expectedStart, selected.meeting.start);
    if (drift === "missing") {
      throw new Error(
        `I can't verify "${selected.meeting.title}" is the same meeting previously shown in this ` +
          `conversation, because there is no recorded meeting list to check it against. Nothing was ` +
          `changed. Call getThreadMeetings first, then ${verb} again with the selectionId it gives you.`,
      );
    }
    if (drift === "changed") {
      throw new Error(
        `"${selected.meeting.title}" changed since it was listed — it was ${formatWhen(expectedStart)}, ` +
          `it's now ${formatWhen(selected.meeting.start)}. Nothing was changed. Re-list this thread's ` +
          `meetings and confirm with the user before acting.`,
      );
    }

    refuseIfGuest(selected.meeting);
    if (!(await userOwnsEvent(userId, selected.meeting.eventId))) {
      throw new Error("That event does not belong to this account.");
    }
    return {
      eventId: selected.meeting.eventId,
      calendarId: selected.meeting.calendarId,
    };
  }

  const target = await resolveWriteTarget(userId, threadId);

  if (target.kind === "none") {
    throw new Error(
      `This thread has no scheduled meeting to ${verb}. Nothing was changed.`,
    );
  }

  // Meetings exist, but every one of them is over. Deliberately NOT reported
  // as "no meeting" — the user can see them on the thread, and a safety check
  // that denies their own history reads as a bug rather than as a refusal.
  if (target.kind === "past-only") {
    const noun = target.meetings.length === 1 ? "meeting" : "meetings";
    throw new Error(
      `This thread's ${noun} already ended, and a finished meeting cannot be ${verb === "cancel" ? "cancelled" : "moved"}. Nothing was changed.\n` +
        `${describeMeetings(target.meetings)}\n` +
        `Say the meeting is over and offer to schedule a NEW one. Do not call this tool again for these.`,
    );
  }

  if (target.kind === "ambiguous") {
    throw new Error(
      `This thread has ${target.meetings.length} scheduled meetings. Nothing was changed.\n` +
        `${describeMeetings(target.meetings)}\n` +
        `Ask the user which one to ${verb}, then call this tool again with that meeting's selectionId. Do not guess.`,
    );
  }

  refuseIfGuest(target.meeting);

  // Defence in depth: the schemas never accept an eventId, so this can only
  // fail if a link outlived the calendar it pointed at.
  //
  // Note this is NOT a substitute for the guest check above — userOwnsEvent
  // asks "is this event in your calendar?", which is true for an attendee too.
  if (!(await userOwnsEvent(userId, target.meeting.eventId))) {
    throw new Error("That event does not belong to this account.");
  }

  return {
    eventId: target.meeting.eventId,
    calendarId: target.meeting.calendarId,
  };
}

