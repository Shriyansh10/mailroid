import { z } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import { hashMailboxList, logger } from "@repo/logger";

import { getThreads, getThread, sendEmail, searchEmails, syncEmails, getStoredEmailCount, searchLocalEmails, generateMissingEmbeddings, getPendingEmbeddingsCount } from "../../../services/index.js";
import {
  trashThread,
  untrashThread,
  setThreadStarred,
  setThreadRead,
  replyToEmail,
  forwardEmail,
  trashThreads,
  untrashThreads,
  setThreadsStarred,
  setThreadsRead,
  setThreadsImportant,
  setThreadsSpam,
  setThreadsCategory,
} from "@repo/services/gmail/index.js";
import {
  getDraft,
  createDraft,
  updateDraft,
  sendDraft,
  discardDraft,
} from "@repo/services/gmail/drafts.js";
import { getEmailsByCategory, getCategoryCounts, getPriorityEmails, getPriorityCounts, getInboxVersion } from "@repo/services/gmail/metadata.js";
import { triggerGmailSync } from "@repo/services/gmail/sync-metadata.js";
import { getSyncStatus } from "@repo/services/gmail/sync-status.js";
import { ALL_CATEGORIES } from "@repo/services/gmail/metadata.js";
import {
  startClassificationJob,
  getLatestClassificationJob,
  countFailedClassifications,
  retryFailedClassifications,
  getClassifyControlsStatus,
  estimateClassificationCost,
  computeCreditPlan,
  scopeToSinceDate,
  LLM_BATCH_SIZE,
} from "@repo/services/gmail/classification.js";
import { getAiReadiness } from "@repo/services/gmail/ai-readiness.js";
import {
  threadListOutputModel,
  threadDetailOutputModel,
  sendEmailOutputModel,
} from "./models.js";

const TAGS = ["Gmail"];
const getPath = generatePath("/gmail");

/**
 * One selection page's worth of threads. Matches PAGE_SIZE in the inbox — the
 * UI can only select what it has rendered — but is enforced here because the
 * real reason for the limit is server-side: every id costs one Gmail call.
 */
const MAX_BULK_THREADS = 50;
const bulkThreadIds = z.array(z.string()).min(1).max(MAX_BULK_THREADS);

/**
 * Only the five inbox tabs are settable. SENT/DRAFT/TRASH/SPAM/OTHER are
 * locations rather than tabs: SPAM has its own procedure, TRASH is trash/
 * untrash, and the rest are not things a user can relabel a thread into.
 */
const SETTABLE_CATEGORIES = ["PRIMARY", "PROMOTIONS", "SOCIAL", "UPDATES", "FORUMS"] as const;

const bulkResultModel = z.object({
  succeeded: z.array(z.string()),
  failed: z.array(z.object({ threadId: z.string(), error: z.string() })),
});

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
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string(),
        body: z.string(),
        threadId: z.string().optional(),
      })
    )
    .output(sendEmailOutputModel)
    .mutation(async ({ ctx, input }) => {
      const startMs = Date.now();
      logger.info("[TRPC] gmail.send called", {
        userId: ctx.user!.id, toHash: hashMailboxList(input.to),
        subjectLength: input.subject?.length ?? 0,
      });
      const result = await sendEmail(ctx.user!.id, input);
      logger.info("[TRPC] gmail.send result", {
        userId: ctx.user!.id, messageId: result.id, threadId: result.threadId,
        durationMs: Date.now() - startMs,
      });
      return result;
    }),

  // Entity-id based, unlike `send`: the threading headers
  // (In-Reply-To/References) are derived server-side from the actual message
  // fetched fresh from Gmail — see resolveReplyTarget in
  // packages/services/gmail/index.ts. This is what keeps a reply in the same
  // Gmail conversation; the generic `send` mutation only carries `threadId`,
  // which Gmail treats as a grouping hint, not the header a client (or
  // another mail client entirely) needs to see the thread stay together.
  //
  // to/cc/bcc are optional overrides for the inline reply box, where a human
  // edits the recipient lines. Omit them and the server derives them exactly
  // as before; pass one (even empty) and it wins. The assistant reaches
  // replyToEmail through the tool registry, not this route, and that schema
  // has no recipient fields at all.
  replyToEmail: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/reply"), tags: TAGS } })
    .input(
      z.object({
        entityId: z.string(),
        body: z.string(),
        replyAll: z.boolean().optional(),
        to: z.string().optional(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
      }),
    )
    .output(sendEmailOutputModel)
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.replyToEmail called", {
        userId: ctx.user!.id, entityId: input.entityId, replyAll: input.replyAll,
      });
      return await replyToEmail(ctx.user!.id, input);
    }),

  // `to` is client-supplied (unlike reply, forwarding has no original
  // recipient to derive) but the quoted original body and subject are always
  // rebuilt server-side from the fetched message — see resolveForwardTarget.
  forwardEmail: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/forward"), tags: TAGS } })
    .input(
      z.object({
        entityId: z.string(),
        to: z.string(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .output(sendEmailOutputModel)
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.forwardEmail called", {
        userId: ctx.user!.id, entityId: input.entityId, toHash: hashMailboxList(input.to),
      });
      return await forwardEmail(ctx.user!.id, input);
    }),

  // ── Mailbox actions (Bin / Star) ───────────────────────────────────
  //
  // Thread-scoped, matching the UI: the list shows threads, so binning or
  // starring applies to the conversation. Each writes to Gmail first and
  // mirrors locally, so a Gmail failure surfaces as a failed mutation and the
  // client rolls its optimistic update back.

  trash: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/trash"), tags: TAGS } })
    .input(z.object({ threadId: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.trash called", { userId: ctx.user!.id, threadId: input.threadId });
      await trashThread(ctx.user!.id, input.threadId);
      return { success: true };
    }),

  untrash: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/untrash"), tags: TAGS } })
    .input(z.object({ threadId: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.untrash called", { userId: ctx.user!.id, threadId: input.threadId });
      await untrashThread(ctx.user!.id, input.threadId);
      return { success: true };
    }),

  setStarred: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/set-starred"), tags: TAGS } })
    .input(z.object({ threadId: z.string(), starred: z.boolean() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.setStarred called", {
        userId: ctx.user!.id, threadId: input.threadId, starred: input.starred,
      });
      await setThreadStarred(ctx.user!.id, input.threadId, input.starred);
      return { success: true };
    }),

  setRead: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/set-read"), tags: TAGS } })
    .input(z.object({ threadId: z.string(), read: z.boolean() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.setRead called", {
        userId: ctx.user!.id, threadId: input.threadId, read: input.read,
      });
      await setThreadRead(ctx.user!.id, input.threadId, input.read);
      return { success: true };
    }),

  // ── Bulk mailbox actions ───────────────────────────────────────────
  //
  // Same thread scoping as the single-id procedures above, applied to a
  // selection. Two things differ and both are deliberate:
  //
  //   * MAX_BULK_THREADS is enforced here, not only in the UI. The cap exists
  //     because each id is a separate Gmail call, so an uncapped array is an
  //     uncapped burst — a client bug or a later caller must not be able to
  //     ask for one.
  //   * The output reports per-thread failures instead of throwing. A batch
  //     can genuinely half-succeed, and the user needs to be told which half.

  trashMany: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/trash-many"), tags: TAGS } })
    .input(z.object({ threadIds: bulkThreadIds }))
    .output(bulkResultModel)
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.trashMany called", {
        userId: ctx.user!.id, count: input.threadIds.length,
      });
      return trashThreads(ctx.user!.id, input.threadIds);
    }),

  untrashMany: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/untrash-many"), tags: TAGS } })
    .input(z.object({ threadIds: bulkThreadIds }))
    .output(bulkResultModel)
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.untrashMany called", {
        userId: ctx.user!.id, count: input.threadIds.length,
      });
      return untrashThreads(ctx.user!.id, input.threadIds);
    }),

  setStarredMany: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/set-starred-many"), tags: TAGS } })
    .input(z.object({ threadIds: bulkThreadIds, starred: z.boolean() }))
    .output(bulkResultModel)
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.setStarredMany called", {
        userId: ctx.user!.id, count: input.threadIds.length, starred: input.starred,
      });
      return setThreadsStarred(ctx.user!.id, input.threadIds, input.starred);
    }),

  setReadMany: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/set-read-many"), tags: TAGS } })
    .input(z.object({ threadIds: bulkThreadIds, read: z.boolean() }))
    .output(bulkResultModel)
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.setReadMany called", {
        userId: ctx.user!.id, count: input.threadIds.length, read: input.read,
      });
      return setThreadsRead(ctx.user!.id, input.threadIds, input.read);
    }),

  setImportantMany: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/set-important-many"), tags: TAGS } })
    .input(z.object({ threadIds: bulkThreadIds, important: z.boolean() }))
    .output(bulkResultModel)
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.setImportantMany called", {
        userId: ctx.user!.id, count: input.threadIds.length, important: input.important,
      });
      return setThreadsImportant(ctx.user!.id, input.threadIds, input.important);
    }),

  setSpamMany: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/set-spam-many"), tags: TAGS } })
    .input(z.object({ threadIds: bulkThreadIds, spam: z.boolean() }))
    .output(bulkResultModel)
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.setSpamMany called", {
        userId: ctx.user!.id, count: input.threadIds.length, spam: input.spam,
      });
      return setThreadsSpam(ctx.user!.id, input.threadIds, input.spam);
    }),

  setCategoryMany: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/set-category-many"), tags: TAGS } })
    .input(z.object({ threadIds: bulkThreadIds, category: z.enum(SETTABLE_CATEGORIES) }))
    .output(bulkResultModel)
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.setCategoryMany called", {
        userId: ctx.user!.id, count: input.threadIds.length, category: input.category,
      });
      return setThreadsCategory(ctx.user!.id, input.threadIds, input.category);
    }),

  // ── Drafts ─────────────────────────────────────────────────────────

  getDraft: protectedProcedure
    .meta({ openapi: { method: "GET", path: getPath("/draft"), tags: TAGS } })
    .input(z.object({ draftId: z.string() }))
    .output(
      z.object({
        draftId: z.string(),
        messageId: z.string(),
        to: z.string(),
        // Bcc round-trips here and only here: a draft is the one place Gmail
        // still holds the header (it strips it on send).
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string(),
        body: z.string(),
        threadId: z.string().optional(),
        isReplyToExisting: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.getDraft called", { userId: ctx.user!.id, draftId: input.draftId });
      return await getDraft(ctx.user!.id, input.draftId);
    }),

  saveDraft: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/draft/save"), tags: TAGS } })
    .input(
      z.object({
        to: z.string(),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string(),
        body: z.string(),
        threadId: z.string().optional(),
        /** Present when editing an existing draft; absent creates a new one. */
        draftId: z.string().optional(),
        /** The message being replied to — set for reply/reply-all drafts so In-Reply-To/References get derived, same as replyToEmail. */
        entityId: z.string().optional(),
        replyAll: z.boolean().optional(),
      }),
    )
    .output(z.object({ draftId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { draftId, ...draft } = input;
      logger.info("[TRPC] gmail.saveDraft called", {
        userId: ctx.user!.id, draftId: draftId ?? null,
        subjectLength: draft.subject?.length ?? 0,
      });
      return draftId
        ? await updateDraft(ctx.user!.id, draftId, draft)
        : await createDraft(ctx.user!.id, draft);
    }),

  sendDraft: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/draft/send"), tags: TAGS } })
    .input(z.object({ draftId: z.string() }))
    .output(sendEmailOutputModel)
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.sendDraft called", { userId: ctx.user!.id, draftId: input.draftId });
      return await sendDraft(ctx.user!.id, input.draftId);
    }),

  discardDraft: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/draft/discard"), tags: TAGS } })
    .input(z.object({ draftId: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.discardDraft called", { userId: ctx.user!.id, draftId: input.draftId });
      await discardDraft(ctx.user!.id, input.draftId);
      return { success: true };
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
        // Which category the sync is on, derived from the resume cursor. This
        // is the waiting screen's second progress signal: `processed /
        // estimatedTotal` depends on a Gmail label estimate that drifts, but
        // the stage is exact and always ends at totalCategories — so the bar
        // keeps moving even when the estimate is wrong.
        stage: z.string().nullable(),
        stageIndex: z.number(),
        totalStages: z.number(),
      }),
    )
    .query(async ({ ctx }) => {
      const row = await getSyncStatus(ctx.user!.id);
      const stageIndex = Math.min(
        row?.cursor?.categoryIndex ?? 0,
        ALL_CATEGORIES.length - 1,
      );
      return {
        status: (row?.status as "queued" | "running" | "complete" | "failed" | undefined) ?? null,
        processed: row?.processed ?? 0,
        estimatedTotal: row?.estimatedTotal ?? null,
        stage: ALL_CATEGORIES[stageIndex] ?? null,
        stageIndex,
        totalStages: ALL_CATEGORIES.length,
      };
    }),

  // Read-only preview for the pre-start confirm dialog — never charges, never
  // creates a job. Uses the exact same estimateClassificationCost the
  // mutation below charges against, so the two can never diverge in formula
  // (only in the harmless sense that time passes between preview and confirm).
  classificationCostEstimate: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/classification-cost-estimate"),
        tags: TAGS,
      },
    })
    .input(z.object({ scope: z.enum(["last_week", "last_month"]) }))
    .output(
      z.object({
        pendingCount: z.number(),
        remainingCredits: z.number(),
        capped: z.boolean(),
        cappedCount: z.number(),
        creditsToCharge: z.number(),
        noCredits: z.boolean(),
        estimatedAiRequests: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const since = scopeToSinceDate(input.scope);
      const estimate = await estimateClassificationCost(ctx.user!.id, since, ctx.user!.email);
      return { ...estimate, estimatedAiRequests: Math.ceil(estimate.cappedCount / LLM_BATCH_SIZE) };
    }),

  // Same preview, for the Retry-failed button — pendingCount here is the
  // FAILED-row count (what would be reset and retried), not a PENDING count.
  retryClassificationCostEstimate: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/retry-classification-cost-estimate"),
        tags: TAGS,
      },
    })
    .output(
      z.object({
        pendingCount: z.number(),
        remainingCredits: z.number(),
        capped: z.boolean(),
        cappedCount: z.number(),
        creditsToCharge: z.number(),
        noCredits: z.boolean(),
        estimatedAiRequests: z.number(),
      }),
    )
    .query(async ({ ctx }) => {
      const failedCount = await countFailedClassifications(ctx.user!.id);
      const estimate = await computeCreditPlan(failedCount, ctx.user!.id, ctx.user!.email);
      return { ...estimate, estimatedAiRequests: Math.ceil(estimate.cappedCount / LLM_BATCH_SIZE) };
    }),

  // Starts a historical bulk classification job ("Classify Last Week" /
  // "Classify Last Month"). Charges 1 credit per 1,000 pending emails
  // (rounded up, capped to what the user's remaining credits can cover — see
  // classification.ts's estimateClassificationCost) once, up front. Rejects
  // with a friendly result (not an error) if one is already running for this
  // user, if there are no credits left today, or if a concurrent request
  // consumed the remaining credits between the estimate and the charge.
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
        capped: z.boolean(),
        cappedCount: z.number(),
        creditsCharged: z.number(),
        reason: z.enum(["already_running", "no_credits", "credits_changed"]).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      logger.info("[TRPC] gmail.startClassificationJob called", { userId: ctx.user!.id, scope: input.scope });
      const result = await startClassificationJob(ctx.user!.id, input.scope, ctx.user!.email);
      if (!result.started) {
        return { started: false, jobId: null, totalCount: 0, capped: false, cappedCount: 0, creditsCharged: 0, reason: result.reason };
      }
      return {
        started: true,
        jobId: result.jobId,
        totalCount: result.totalCount,
        capped: result.capped,
        cappedCount: result.cappedCount,
        creditsCharged: result.creditsCharged,
        reason: null,
      };
    }),

  // Clears the attempt cap on emails stuck at FAILED and classifies them.
  // Separate from startClassificationJob because it takes no scope — the
  // window is derived from where the failed rows are, which no fixed scope
  // would reliably cover. Costed identically to startClassificationJob —
  // otherwise a user capped out on "Classify Last Month" could retry-loop
  // their way to unlimited free classification.
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
        capped: z.boolean(),
        cappedCount: z.number(),
        creditsCharged: z.number(),
        reason: z.enum(["already_running", "no_credits", "credits_changed"]).nullable(),
      }),
    )
    .mutation(async ({ ctx }) => {
      logger.info("[TRPC] gmail.retryFailedClassifications called", { userId: ctx.user!.id });
      const result = await retryFailedClassifications(ctx.user!.id, ctx.user!.email);
      if (!result.started) {
        return { started: false, jobId: null, totalCount: 0, resetCount: 0, capped: false, cappedCount: 0, creditsCharged: 0, reason: result.reason };
      }
      return {
        started: true,
        jobId: result.jobId,
        totalCount: result.totalCount,
        resetCount: result.resetCount,
        capped: result.capped,
        cappedCount: result.cappedCount,
        creditsCharged: result.creditsCharged,
        reason: null,
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

  // Gates Dobbie/semantic search. `ready` is a write-once latch — true
  // forever once a user's first-ever classify window has fully classified,
  // hydrated, AND indexed. `setup` is only populated while ready === false
  // and drives the setup progress bar; see ai-readiness.ts for why this is
  // NOT a live "drained right now" check (that would flicker Dobbie off on
  // every new webhook email).
  aiReadiness: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/ai-readiness"),
        tags: TAGS,
      },
    })
    .output(
      z.object({
        ready: z.boolean(),
        setup: z
          .object({
            classification: z.object({ done: z.number(), total: z.number() }),
            hydration: z.object({ done: z.number(), total: z.number() }),
            indexing: z.object({ done: z.number(), total: z.number() }),
          })
          .nullable(),
      }),
    )
    .query(async ({ ctx }) => {
      return getAiReadiness(ctx.user!.id);
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
      // Belt-and-braces alongside the client-side disabled search input:
      // `ready` is a one-time latch (see ai-readiness.ts), so this only ever
      // blocks a user's first-ever setup window, never an established user.
      const readiness = await getAiReadiness(ctx.user!.id);
      if (!readiness.ready) {
        logger.info("[TRPC] gmail.searchLocal short-circuited: AI setup not ready", { userId: ctx.user!.id });
        return { threads: [], total: 0 };
      }
      const result = await searchLocalEmails(ctx.user!.id, { query: input.query });
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
