import { z } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";

import { getThreads, getThread, sendEmail, searchEmails, syncEmails, getStoredEmailCount, searchLocalEmails, generateMissingEmbeddings, getPendingEmbeddingsCount } from "../../../services/index.js";
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

  sync: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/sync"),
        tags: TAGS,
      },
    })
    .output(z.object({ synced: z.number() }))
    .mutation(async ({ ctx }) => {
      return syncEmails(ctx.user!.id, ctx.user!.id);
    }),

  storedCount: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/stored-count"),
        tags: TAGS,
      },
    })
    .output(z.object({ count: z.number() }))
    .query(async ({ ctx }) => {
      return getStoredEmailCount(ctx.user!.id);
    }),

  searchLocal: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/search-local"),
        tags: TAGS,
      },
    })
    .input(z.object({ query: z.string().min(1) }))
    .output(
      z.object({
        threads: threadListOutputModel.shape.threads,
        total: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return searchLocalEmails(ctx.user!.id, input.query);
    }),

  generateEmbeddings: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/generate-embeddings"),
        tags: TAGS,
      },
    })
    .output(z.object({ embedded: z.number() }))
    .mutation(async ({ ctx }) => {
      return generateMissingEmbeddings(ctx.user!.id);
    }),

  pendingEmbeddingsCount: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/pending-embeddings"),
        tags: TAGS,
      },
    })
    .output(z.object({ pending: z.number() }))
    .query(async ({ ctx }) => {
      return getPendingEmbeddingsCount(ctx.user!.id);
    }),
});
