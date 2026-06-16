import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError } from "@repo/ai";
import { getEvents as corsairGetEvents } from "@repo/services/calendar/index";

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
