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
