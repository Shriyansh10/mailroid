import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError } from "@repo/ai";
import { getEvents as corsairGetEvents, createEvent as corsairCreateEvent } from "@repo/services/calendar/index";

const MAX_EVENT_RESULTS = 20;

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

      const result = await corsairGetEvents(ctx.userId, {
        timeMin: args.timeMin ?? now,
        timeMax: args.timeMax ?? thirtyDaysLater,
      });

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
    });
    try {
      const result = await corsairCreateEvent(ctx.userId, {
        title: args.title,
        start: args.start,
        end: args.end,
        allDay: false,
        attendees: args.attendees,
        description: args.description,
      });

      console.log("[executor:createEvent] SUCCESS", { id: result.id, title: result.title });
      return { draft: false, id: result.id };
    } catch (error) {
      console.error("[executor:createEvent] ERROR", { error: String(error), userId: ctx.userId });
      throw new ToolExecutionError("createEvent", error);
    }
  }
}

