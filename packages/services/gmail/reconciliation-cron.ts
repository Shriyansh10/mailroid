import { inngest } from "@repo/inngest";
import { db, eq, and, lt } from "@repo/database";
import { gmailSyncStatus } from "@repo/database/models/gmail-sync-status";
import { classificationJobs } from "@repo/database/models/classification-jobs";
import { logger } from "@repo/logger";

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Both gmailInitialSync (initial-sync.ts) and classificationBatch
 * (classification-batch.ts) self-chain via a single continuation event. If
 * that event is ever lost — an Inngest outage, a bug, a dropped delivery —
 * the job sits at 'running' forever: a frozen progress bar with nothing left
 * to restart it. This runs every 15 minutes and re-kicks anything that's
 * been 'running' without a progress update for longer than
 * STALE_THRESHOLD_MS, resuming from the exact DB checkpoint (sync's stored
 * cursor / classification's PENDING rows) rather than from scratch.
 *
 * Deliberately does NOT touch rows already 'failed' — those are terminal
 * (Inngest's own retries were exhausted and onFailure already ran). Only a
 * job that's genuinely stuck at 'running' with no progress gets rescued
 * here; a job that failed and was marked as such stays failed.
 *
 * NOTE: lives in @repo/services (not @repo/inngest) for the same
 * one-directional-dependency reason as gmailInitialSync — see initial-sync.ts.
 */
export const reconciliationCron = inngest.createFunction(
  { id: "reconciliation-cron" },
  [{ cron: "*/15 * * * *" }, { event: "reconciliation/run" }],
  async ({ step }) => {
    const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS);

    const stalledSyncs = await step.run("find-stalled-syncs", () =>
      db
        .select()
        .from(gmailSyncStatus)
        .where(and(eq(gmailSyncStatus.status, "running"), lt(gmailSyncStatus.updatedAt, staleBefore))),
    );

    for (const row of stalledSyncs) {
      await step.sendEvent(`rekick-sync-${row.userId}`, {
        name: "gmail/sync.requested",
        data: {
          userId: row.userId,
          // Explicitly 0 (not undefined) — this is always a resume, and
          // isFirstRun in initial-sync.ts checks specifically for
          // categoryIndex === undefined to decide whether to re-mark
          // 'running' / re-estimate the total. A stalled row is already
          // running with an estimate, so it must look like a continuation.
          categoryIndex: row.cursor?.categoryIndex ?? 0,
          pageToken: row.cursor?.pageToken ?? undefined,
          syncedTotal: row.processed,
        },
      });
      logger.warn("[RECONCILE] re-kicked stalled sync", {
        userId: row.userId, processed: row.processed, updatedAt: row.updatedAt,
      });
    }

    const stalledJobs = await step.run("find-stalled-jobs", () =>
      db
        .select()
        .from(classificationJobs)
        .where(and(eq(classificationJobs.status, "running"), lt(classificationJobs.updatedAt, staleBefore))),
    );

    for (const row of stalledJobs) {
      await step.sendEvent(`rekick-classification-${row.id}`, {
        name: "classification/batch.requested",
        data: { jobId: row.id, userId: row.userId, since: new Date(row.since).toISOString() },
      });
      logger.warn("[RECONCILE] re-kicked stalled classification job", {
        jobId: row.id, userId: row.userId, updatedAt: row.updatedAt,
      });
    }

    return { stalledSyncs: stalledSyncs.length, stalledJobs: stalledJobs.length };
  },
);
