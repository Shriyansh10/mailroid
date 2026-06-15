import { z } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";

import { getThreads, getThread, sendEmail, searchEmails } from "../../../services/index.js";
import {
  threadListOutputModel,
  threadDetailOutputModel,
  sendEmailOutputModel,
} from "./models.js";

const TAGS = ["Gmail"];
const getPath = generatePath("/gmail");

export const gmailRouter = router({
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/list"),
        tags: TAGS,
      },
    })
    .input(
      z
        .object({
          maxResults: z.number().optional(),
          pageToken: z.string().optional(),
        })
        .optional()
    )
    .output(threadListOutputModel)
    .query(async ({ ctx, input }) => {
      return getThreads(ctx.user!.id, input ?? undefined);
    }),

  thread: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/thread"),
        tags: TAGS,
      },
    })
    .input(z.object({ id: z.string() }))
    .output(threadDetailOutputModel)
    .query(async ({ ctx, input }) => {
      return getThread(ctx.user!.id, input.id);
    }),

  send: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/send"),
        tags: TAGS,
      },
    })
    .input(
      z.object({
        to: z.string(),
        subject: z.string(),
        body: z.string(),
        threadId: z.string().optional(),
      })
    )
    .output(sendEmailOutputModel)
    .mutation(async ({ ctx, input }) => {
      return sendEmail(ctx.user!.id, input);
    }),

  search: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/search"),
        tags: TAGS,
      },
    })
    .input(
      z.object({
        query: z.string(),
        maxResults: z.number().optional(),
        pageToken: z.string().optional(),
      })
    )
    .output(threadListOutputModel)
    .query(async ({ ctx, input }) => {
      return searchEmails(ctx.user!.id, input.query, {
        maxResults: input.maxResults,
        pageToken: input.pageToken,
      });
    }),
});
