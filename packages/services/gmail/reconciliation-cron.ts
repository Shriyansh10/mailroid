import { inngest } from "@repo/inngest";
import { db, eq, and, lt, sql } from "@repo/database";
import { gmailSyncStatus } from "@repo/database/models/gmail-sync-status";
import { classificationJobs } from "@repo/database/models/classification-jobs";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";

import { deleteExpiredPauses, getPausedTenantIds, isTenantPaused } from "./pause.ts";

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Both gmailInitialSync (initial-sync.ts) and classificationBatch
 * (classification-batch.ts) self-chain via a single continuation event. If
 * that event is ever lost — an Inngest outage, a bug, a dropped delivery —
 * the job sits at 'running' forever: a frozen progress bar with nothing left
 * to restart it. This runs once a day and re-kicks anything that's
 * been 'running' without a progress update for longer than
 * STALE_THRESHOLD_MS, resuming from the exact DB checkpoint (sync's stored
 * cursor / classification's PENDING rows) rather than from scratch.
 *
 * Was every 15 minutes; dropped to daily because the cooldown-resume probe
 * that used to live in this same function (a live Gmail call) was itself
 * re-triggering 429s on a mailbox whose underlying Google-side block
 * outlasted a single Retry-After window — each 15-minute probe renewed the
 * block by another 15 minutes, the same feedback loop this mechanism exists
 * to avoid, just on a slower cadence. That probe now lives in its own hourly
 * function (cooldown-resume-cron.ts), matching the 60-minute escalation cap
 * in quota-cooldown.ts, so a quiet recovering mailbox isn't gated on this
 * daily sweep. A stuck sync/job is rare enough that a daily sweep is still a
 * same-day fix; a real webhook still resumes a mailbox immediately once
 * Gmail actually clears it, independent of either cron.
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
  [{ cron: "0 0 * * *" }, { event: "reconciliation/run" }],
  async ({ step }) => {
    const staleBefore = new Date(Date.now() - STALE_THRESHOLD_MS);

    // Janitorial: expired pause rows are already inert (an expired row reads
    // exactly like an absent one — see pause.ts), so this is cosmetic and a
    // missed run costs nothing. It lives here rather than on the read path
    // because a read that can write turns every Gmail call into a DB writer.
    const expiredPauses = await step.run("cleanup-expired-pauses", () =>
      deleteExpiredPauses(),
    );

    // Re-kicking sync/hydration for a paused mailbox would restart exactly the
    // Google traffic the pause exists to stop.
    const paused = await step.run("find-paused-tenants", async () => [
      ...(await getPausedTenantIds()),
    ]);
    const pausedSet = new Set(paused);

    // Classification is LLM-bound, not Gmail-bound, so a `sync` pause has no
    // reason to stop it — that pause is about not talking to Google. Only a
    // deactivated account or whole-app maintenance should stop spending tokens.
    const localWorkPaused = await step.run("find-local-work-paused-tenants", async () => [
      ...(await getPausedTenantIds({ blockingLocalWork: true })),
    ]);
    const localWorkPausedSet = new Set(localWorkPaused);

    const stalledSyncs = await step.run("find-stalled-syncs", () =>
      db
        .select()
        .from(gmailSyncStatus)
        .where(and(eq(gmailSyncStatus.status, "running"), lt(gmailSyncStatus.updatedAt, staleBefore))),
    );

    for (const row of stalledSyncs) {
      if (isTenantPaused(pausedSet, row.userId)) continue;
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
      if (isTenantPaused(localWorkPausedSet, row.userId)) continue;
      await step.sendEvent(`rekick-classification-${row.id}`, {
        name: "classification/batch.requested",
        data: { jobId: row.id, userId: row.userId, since: new Date(row.since).toISOString() },
      });
      logger.warn("[RECONCILE] re-kicked stalled classification job", {
        jobId: row.id, userId: row.userId, updatedAt: row.updatedAt,
      });
    }

    // Hydration has no separate job-bookkeeping table (unlike sync/classify) —
    // message_metadata.hydration_status IS the checkpoint. A row stuck at
    // HYDRATING (claimed, then the worker/container died before ingestMessage
    // resolved) is indistinguishable from "still fetching" without the
    // updatedAt staleness check, since PENDING alone can't tell "never picked
    // up" from "worker died mid-fetch" apart — that's the whole reason
    // HYDRATING exists as its own state. Grouped by user so one re-kick event
    // resumes every stale row for that user, using the earliest stale row's
    // receivedAt as the resumption `since` (hydration keeps no persisted job
    // row to read a `since` back from, unlike classification_jobs).
    const stalledHydrations = await step.run("find-stalled-hydrations", () =>
      db
        .select({
          userId: messageMetadata.userId,
          minReceivedAt: sql<string>`min(${messageMetadata.receivedAt})`,
        })
        .from(messageMetadata)
        .where(and(eq(messageMetadata.hydrationStatus, "HYDRATING"), lt(messageMetadata.updatedAt, staleBefore)))
        .groupBy(messageMetadata.userId),
    );

    for (const row of stalledHydrations) {
      if (isTenantPaused(pausedSet, row.userId)) continue;
      await step.run(`reset-hydrating-${row.userId}`, () =>
        db
          .update(messageMetadata)
          .set({ hydrationStatus: "PENDING", updatedAt: new Date() })
          .where(
            and(
              eq(messageMetadata.userId, row.userId),
              eq(messageMetadata.hydrationStatus, "HYDRATING"),
              lt(messageMetadata.updatedAt, staleBefore),
            ),
          ),
      );

      await step.sendEvent(`rekick-hydration-${row.userId}`, {
        name: "email/hydrate.requested",
        data: { userId: row.userId, since: new Date(row.minReceivedAt).toISOString() },
      });
      logger.warn("[RECONCILE] re-kicked stalled hydration", { userId: row.userId });
    }

    return {
      stalledSyncs: stalledSyncs.length,
      stalledJobs: stalledJobs.length,
      stalledHydrations: stalledHydrations.length,
      expiredPausesDeleted: expiredPauses,
    };
  },
);
