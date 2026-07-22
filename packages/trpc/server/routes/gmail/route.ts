import { z } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import { logger } from "@repo/logger";

import { getThreads, getThread, sendEmail, searchEmails, syncEmails, getStoredEmailCount, searchLocalEmails, generateMissingEmbeddings, getPendingEmbeddingsCount } from "../../../services/index.js";
import { getEmailsByCategory, getCategoryCounts, getPriorityEmails, getPriorityCounts, getInboxVersion } from "@repo/services/gmail/metadata.js";
import { triggerGmailSync } from "@repo/services/gmail/sync-metadata.js";
import { getSyncStatus } from "@repo/services/gmail/sync-status.js";
import {
  startClassificationJob,
  getLatestClassificationJob,
  countFailedClassifications,
  retryFailedClassifications,
  getClassifyControlsStatus,
} from "@repo/services/gmail/classification.js";
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

  // Full, durable re-sync of the CURRENT user's entire mailbox. Enqueues the
  // resumable Inngest job (or runs in-process if Inngest isn't configured).
  // Use this to backfill an account that only partially synced.
  resync: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/resync"),
        tags: TAGS,
      },
    })
    .output(z.object({ queued: z.boolean() }))
    .mutation(async ({ ctx }) => {
      logger.info("[TRPC] gmail.resync called", { userId: ctx.user!.id });
      await triggerGmailSync(ctx.user!.id);
      return { queued: true };
    }),

  // Polled by the onboarding waiting screen and (once complete) used to gate
  // historical classification. status is 'queued' | 'running' | 'complete' |
  // 'failed' | null (no sync has ever been triggered for this user).
  syncStatus: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/sync-status"),
        tags: TAGS,
      },
    })
    .output(
      z.object({
        status: z.enum(["queued", "running", "complete", "failed"]).nullable(),
        processed: z.number(),
        estimatedTotal: z.number().nullable(),
      }),
    )
    .query(async ({ ctx }) => {
      const row = await getSyncStatus(ctx.user!.id);
      return {
        status: (row?.status as "queued" | "running" | "complete" | "failed" | undefined) ?? null,
        processed: row?.processed ?? 0,
        estimatedTotal: row?.estimatedTotal ?? null,
      };
    }),

  // Starts a historical bulk classification job ("Classify Last Week" /
  // "Classify Last Month"). Rejects with a friendly result (not an error) if
  // one is already running for this user — the unique partial index on
  // classification_jobs is the actual guard; this just surfaces it cleanly.
  startClassificationJob: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/start-classification-job"),
        tags: TAGS,
      },
    })
    .input(z.object({ scope: z.enum(["last_week", "last_month"]) }))
    .output(
      z.object({
        started: z.boolean(),
        jobId: z.string().nullable(),
        totalCount: z.number(),
        alreadyRunning: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.startClassificationJob called", { userId: ctx.user!.id, scope: input.scope });
      const result = await startClassificationJob(ctx.user!.id, input.scope);
      if (!result.started) {
        return { started: false, jobId: null, totalCount: 0, alreadyRunning: true };
      }
      return { started: true, jobId: result.jobId, totalCount: result.totalCount, alreadyRunning: false };
    }),

  // Clears the attempt cap on emails stuck at FAILED and classifies them.
  // Separate from startClassificationJob because it takes no scope — the
  // window is derived from where the failed rows are, which no fixed scope
  // would reliably cover.
  retryFailedClassifications: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/retry-failed-classifications"),
        tags: TAGS,
      },
    })
    .input(z.object({}))
    .output(
      z.object({
        started: z.boolean(),
        jobId: z.string().nullable(),
        totalCount: z.number(),
        resetCount: z.number(),
        alreadyRunning: z.boolean(),
      }),
    )
    .mutation(async ({ ctx }) => {
      logger.info("[TRPC] gmail.retryFailedClassifications called", { userId: ctx.user!.id });
      const result = await retryFailedClassifications(ctx.user!.id);
      if (!result.started) {
        return { started: false, jobId: null, totalCount: 0, resetCount: 0, alreadyRunning: true };
      }
      return {
        started: true,
        jobId: result.jobId,
        totalCount: result.totalCount,
        resetCount: result.resetCount,
        alreadyRunning: false,
      };
    }),

  // Polled by the priority inbox while a classification job is in flight.
  classificationJobStatus: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/classification-job-status"),
        tags: TAGS,
      },
    })
    .output(
      z.object({
        status: z.enum(["running", "complete", "failed"]).nullable(),
        scope: z.string().nullable(),
        processedCount: z.number(),
        totalCount: z.number(),
        // Emails stuck at the attempt cap. Reported alongside job status so the
        // inbox can explain a "nothing to classify" result instead of leaving
        // the user with an Unclassified count nothing will ever act on.
        failedCount: z.number(),
      }),
    )
    .query(async ({ ctx }) => {
      const [job, failedCount] = await Promise.all([
        getLatestClassificationJob(ctx.user!.id),
        countFailedClassifications(ctx.user!.id),
      ]);
      return {
        status: (job?.status as "running" | "complete" | "failed" | undefined) ?? null,
        scope: job?.scope ?? null,
        processedCount: job?.processedCount ?? 0,
        totalCount: job?.totalCount ?? 0,
        failedCount,
      };
    }),

  // Drives the priority tab's classify controls: whether the one-time scope
  // buttons should still render (hasClassified === false), and once they're
  // gone, whether a Retry button is warranted (unclassified emails left in
  // the job's own window, or rows stuck at the attempt cap).
  classifyControlsStatus: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/classify-controls-status"),
        tags: TAGS,
      },
    })
    .output(
      z.object({
        hasClassified: z.boolean(),
        remainingUnclassified: z.number(),
        failedCount: z.number(),
      }),
    )
    .query(async ({ ctx }) => {
      return getClassifyControlsStatus(ctx.user!.id);
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

  // Cheap per-user change token. The client polls this on an interval and only
  // re-fetches its cached inbox lists when the returned version grows, so a
  // webhook that touches user A's mail refreshes only A — user B, whose version
  // is unchanged, never refetches.
  inboxVersion: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/inbox-version"),
        tags: TAGS,
      },
    })
    .output(z.object({ version: z.number() }))
    .query(async ({ ctx }) => {
      return getInboxVersion(ctx.user!.id);
    }),

  listPriority: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/list-priority"),
        tags: TAGS,
      },
    })
    .input(
      z
        .object({
          priorities: z.array(z.string()).optional(),
          days: z.number().optional(),
          unreadOnly: z.boolean().optional(),
          maxResults: z.number().optional(),
          page: z.number().optional(),
        })
        .optional()
    )
    .output(
      z.object({
        threads: threadListOutputModel.shape.threads,
      }),
    )
    .query(async ({ ctx, input }) => {
      const startMs = Date.now();
      logger.info("[TRPC] gmail.listPriority called", {
        userId: ctx.user!.id, input: input ?? {}
      });
      const result = await getPriorityEmails(ctx.user!.id, {
        priorities: input?.priorities,
        days: input?.days,
        unreadOnly: input?.unreadOnly,
        maxResults: input?.maxResults,
        page: input?.page,
      });
      logger.info("[TRPC] gmail.listPriority result", {
        userId: ctx.user!.id,
        threadCount: result.threads?.length ?? 0,
        durationMs: Date.now() - startMs,
      });
      return result;
    }),

  priorityCounts: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/priority-counts"),
        tags: TAGS,
      },
    })
    .input(
      z
        .object({
          days: z.number().optional(),
        })
        .optional()
    )
    .output(
      z.object({
        HIGH: z.number(),
        MEDIUM: z.number(),
        LOW: z.number(),
        UNCLASSIFIED: z.number(),
        ALL: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const startMs = Date.now();
      logger.info("[TRPC] gmail.priorityCounts called", { userId: ctx.user!.id, input: input ?? {} });
      const result = await getPriorityCounts(ctx.user!.id, input?.days ?? undefined);
      logger.info("[TRPC] gmail.priorityCounts result", {
        userId: ctx.user!.id, counts: result, durationMs: Date.now() - startMs,
      });
      return result;
    }),
});
