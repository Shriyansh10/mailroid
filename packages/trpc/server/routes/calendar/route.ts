import { z } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";

import {
  getEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
} from "../../../services/index.js";
import { getCalendarVersion } from "@repo/services/calendar/version.js";

import {
  calendarEventListOutputModel,
  calendarEventOutputModel,
  createEventInputModel,
  updateEventInputModel,
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
    .output(calendarEventOutputModel)
    .mutation(async ({ ctx, input }) => {
      return createEvent(ctx.user!.id, input);
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
      return { success: true };
    }),
});
