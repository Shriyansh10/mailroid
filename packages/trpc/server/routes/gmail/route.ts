import { z } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import { logger } from "@repo/logger";

import { getThreads, getThread, sendEmail, searchEmails, syncEmails, getStoredEmailCount, searchLocalEmails, generateMissingEmbeddings, getPendingEmbeddingsCount } from "../../../services/index.js";
import { getEmailsByCategory, getCategoryCounts } from "@repo/services/gmail/metadata.js";
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
      const startMs = Date.now();
      logger.info("[TRPC] gmail.list called", { userId: ctx.user!.id, input: input ?? {} });
      const result = await getThreads(ctx.user!.id, input ?? undefined);
      logger.info("[TRPC] gmail.list result", {
        userId: ctx.user!.id, threadCount: result.threads?.length ?? 0,
        hasNextPage: !!result.nextPageToken, durationMs: Date.now() - startMs,
      });
      return result;
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
      const startMs = Date.now();
      logger.info("[TRPC] gmail.thread called", { userId: ctx.user!.id, threadId: input.id });
      const result = await getThread(ctx.user!.id, input.id);
      logger.info("[TRPC] gmail.thread result", {
        userId: ctx.user!.id, threadId: input.id,
        messageCount: result.messages?.length ?? 0, durationMs: Date.now() - startMs,
      });
      return result;
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
      const startMs = Date.now();
      logger.info("[TRPC] gmail.send called", { userId: ctx.user!.id, to: input.to, subject: input.subject });
      const result = await sendEmail(ctx.user!.id, input);
      logger.info("[TRPC] gmail.send result", {
        userId: ctx.user!.id, messageId: result.id, threadId: result.threadId,
        durationMs: Date.now() - startMs,
      });
      return result;
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
      const startMs = Date.now();
      logger.info("[TRPC] gmail.search called", {
        userId: ctx.user!.id, query: input.query,
        maxResults: input.maxResults, pageToken: input.pageToken,
      });
      const result = await searchEmails(ctx.user!.id, input.query, {
        maxResults: input.maxResults,
        pageToken: input.pageToken,
      });
      logger.info("[TRPC] gmail.search result", {
        userId: ctx.user!.id, query: input.query,
        threadCount: result.threads?.length ?? 0,
        hasNextPage: !!result.nextPageToken, durationMs: Date.now() - startMs,
      });
      return result;
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
      const startMs = Date.now();
      logger.info("[TRPC] gmail.sync called", { userId: ctx.user!.id });
      const result = await syncEmails(ctx.user!.id, ctx.user!.id);
      logger.info("[TRPC] gmail.sync result", {
        userId: ctx.user!.id, synced: result.synced, durationMs: Date.now() - startMs,
      });
      return result;
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
      const startMs = Date.now();
      logger.info("[TRPC] gmail.storedCount called", { userId: ctx.user!.id });
      const result = await getStoredEmailCount(ctx.user!.id);
      logger.info("[TRPC] gmail.storedCount result", {
        userId: ctx.user!.id, count: result.count, durationMs: Date.now() - startMs,
      });
      return result;
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
      const startMs = Date.now();
      logger.info("[TRPC] gmail.searchLocal called", { userId: ctx.user!.id, query: input.query });
      const result = await searchLocalEmails(ctx.user!.id, input.query);
      logger.info("[TRPC] gmail.searchLocal result", {
        userId: ctx.user!.id, query: input.query,
        threadCount: result.threads?.length ?? 0, total: result.total,
        durationMs: Date.now() - startMs,
      });
      return result;
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
      const startMs = Date.now();
      logger.info("[TRPC] gmail.generateEmbeddings called", { userId: ctx.user!.id });
      const result = await generateMissingEmbeddings(ctx.user!.id);
      logger.info("[TRPC] gmail.generateEmbeddings result", {
        userId: ctx.user!.id, embedded: result.embedded, durationMs: Date.now() - startMs,
      });
      return result;
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
      const startMs = Date.now();
      logger.info("[TRPC] gmail.pendingEmbeddingsCount called", { userId: ctx.user!.id });
      const result = await getPendingEmbeddingsCount(ctx.user!.id);
      logger.info("[TRPC] gmail.pendingEmbeddingsCount result", {
        userId: ctx.user!.id, pending: result.pending, durationMs: Date.now() - startMs,
      });
      return result;
    }),

  listByCategory: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/list-by-category"),
        tags: TAGS,
      },
    })
    .input(
      z.object({
        category: z.string(),
        maxResults: z.number().optional(),
        page: z.number().optional(),
      }),
    )
    .output(
      z.object({
        threads: threadListOutputModel.shape.threads,
      }),
    )
    .query(async ({ ctx, input }) => {
      const startMs = Date.now();
      logger.info("[TRPC] gmail.listByCategory called", {
        userId: ctx.user!.id, category: input.category,
        maxResults: input.maxResults, page: input.page,
      });
      const result = await getEmailsByCategory(ctx.user!.id, input.category, {
        maxResults: input.maxResults,
        page: input.page,
      });
      logger.info("[TRPC] gmail.listByCategory result", {
        userId: ctx.user!.id, category: input.category,
        threadCount: result.threads?.length ?? 0,
        durationMs: Date.now() - startMs,
      });
      return result;
    }),

  categoryCounts: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/category-counts"),
        tags: TAGS,
      },
    })
    .output(z.record(z.string(), z.number()))
    .query(async ({ ctx }) => {
      const startMs = Date.now();
      logger.info("[TRPC] gmail.categoryCounts called", { userId: ctx.user!.id });
      const result = await getCategoryCounts(ctx.user!.id);
      logger.info("[TRPC] gmail.categoryCounts result", {
        userId: ctx.user!.id, counts: result, durationMs: Date.now() - startMs,
      });
      return result;
    }),
});
