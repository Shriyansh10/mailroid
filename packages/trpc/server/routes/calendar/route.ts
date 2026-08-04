import { z } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";

import {
  getEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  linkThreadEvent,
  closeThreadLink,
  acknowledgeThreadLink,
  getActiveThreadMeetings,
  getUnacknowledgedDeletion,
} from "../../../services/index.js";
import { getCalendarVersion } from "@repo/services/calendar/version.js";

import {
  calendarEventListOutputModel,
  calendarEventOutputModel,
  createEventInputModel,
  createEventOutputModel,
  updateEventInputModel,
  threadMeetingsOutputModel,
} from "./models.js";

const TAGS = ["Calendar"];
const getPath = generatePath("/calendar");

export const calendarRouter = router({
  events: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/events"),
        tags: TAGS,
      },
    })
    .input(z.object({ timeMin: z.string(), timeMax: z.string() }))
    .output(calendarEventListOutputModel)
    .query(async ({ ctx, input }) => {
      return getEvents(ctx.user!.id, input);
    }),

  // Cheap per-user change token. The client polls this and re-fetches its
  // cached event lists only when it grows — mirrors gmail.inboxVersion so a
  // calendar webhook refreshes the UI without a manual reload.
  calendarVersion: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/version"),
        tags: TAGS,
      },
    })
    .output(z.object({ version: z.number() }))
    .query(async ({ ctx }) => {
      return getCalendarVersion(ctx.user!.id);
    }),

  event: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/event"),
        tags: TAGS,
      },
    })
    .input(z.object({ id: z.string() }))
    .output(calendarEventOutputModel)
    .query(async ({ ctx, input }) => {
      return getEvent(ctx.user!.id, input.id);
    }),

  create: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/create"),
        tags: TAGS,
      },
    })
    .input(createEventInputModel)
    .output(createEventOutputModel)
    .mutation(async ({ ctx, input }) => {
      const { threadId, entityId, ...eventInput } = input;
      const event = await createEvent(ctx.user!.id, eventInput);

      if (!threadId) return { ...event, linked: true };

      // Google first, then the link, both awaited before the caller sees
      // success. If the link fails the event still exists, so this is a
      // *partial* success, not a failure: reporting it as a failure would send
      // the user into a retry that creates the duplicate this whole feature
      // exists to prevent. The caller reads `linked` and suppresses Retry.
      try {
        await linkThreadEvent({
          userId: ctx.user!.id,
          threadId,
          eventId: event.id,
          entityId,
        });
        return { ...event, linked: true };
      } catch (error) {
        console.error("[calendar:create] link failed", {
          userId: ctx.user!.id,
          threadId,
          eventId: event.id,
          error: String(error),
        });
        return { ...event, linked: false };
      }
    }),

  // Active meetings scheduled from a Gmail thread, plus any deletion the user
  // hasn't acknowledged. Note this query self-heals links whose event has
  // vanished, so it has a write side effect and may call the Calendar API.
  // That's idempotent and self-limiting — a link is resolved against Google at
  // most once, because stamping it takes it out of ACTIVE — but it should not
  // be put on an aggressive refetch interval.
  threadMeetings: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/thread-meetings"),
        tags: TAGS,
      },
    })
    .input(z.object({ threadId: z.string() }))
    .output(threadMeetingsOutputModel)
    .query(async ({ ctx, input }) => {
      const meetings = await getActiveThreadMeetings(
        ctx.user!.id,
        input.threadId,
      );
      const deletedLink = await getUnacknowledgedDeletion(
        ctx.user!.id,
        input.threadId,
      );
      return { meetings, deletedLink };
    }),

  // Dismiss the "this meeting no longer exists" banner.
  acknowledgeThreadMeeting: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/acknowledge-thread-meeting"),
        tags: TAGS,
      },
    })
    .input(z.object({ eventId: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await acknowledgeThreadLink(ctx.user!.id, input.eventId);
      return { success: true };
    }),

  update: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/update"),
        tags: TAGS,
      },
    })
    .input(updateEventInputModel)
    .output(calendarEventOutputModel)
    .mutation(async ({ ctx, input }) => {
      const { id, ...rest } = input;
      return updateEvent(ctx.user!.id, id, rest);
    }),

  delete: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/delete"),
        tags: TAGS,
      },
    })
    .input(z.object({ id: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await deleteEvent(ctx.user!.id, input.id);
      // Close any thread link for this event. Keyed by eventId, so no threadId
      // input is needed. CANCELLED, not DELETED_EXTERNALLY: we did this.
      await closeThreadLink(ctx.user!.id, "primary", input.id, "CANCELLED");
      return { success: true };
    }),
});
