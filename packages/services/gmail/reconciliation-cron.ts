import { inngest } from "@repo/inngest";
import { corsair } from "@repo/corsair";
import { db, eq, and, lt, sql } from "@repo/database";
import { gmailSyncStatus } from "@repo/database/models/gmail-sync-status";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { classificationJobs } from "@repo/database/models/classification-jobs";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";

import { clearCooldown, recordQuotaError } from "./quota-cooldown.ts";

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

    // A webhook that arrived during a Gmail quota cooldown was acked with 200
    // and never processed (see webhook-handler.ts). The cursor didn't move, so
    // nothing is lost — but nothing re-reads it either. Waiting for the next
    // inbound email would leave recovery hostage to whether someone happens to
    // write to that mailbox, which for a quiet mailbox could be days.
    //
    // So once the window passes, we re-trigger the diff ourselves: ask Gmail
    // for the mailbox's current historyId (users.getProfile, 1 quota unit) and
    // emit the same notification the webhook would have.
    const expiredCooldowns = await step.run("find-expired-cooldowns", () =>
      db
        .select({
          tenantId: gmailTenantMappings.tenantId,
          emailAddress: gmailTenantMappings.emailAddress,
          until: gmailTenantMappings.quotaCooldownUntil,
        })
        .from(gmailTenantMappings)
        .where(lt(gmailTenantMappings.quotaCooldownUntil, new Date())),
    );

    for (const row of expiredCooldowns) {
      await step.run(`resume-after-cooldown-${row.tenantId}`, async () => {
        // Mailboxes throttled by one underlying event get handed similar
        // Retry-After values, so their windows expire together — and this cron
        // would then fire every resume in a single burst, which is a smaller
        // version of the traffic spike that caused the outage. Spread them.
        await new Promise((r) => setTimeout(r, Math.random() * 60_000));

        const tenant = corsair.withTenant(row.tenantId);
        const accessToken = await tenant.gmail.keys.get_access_token();
        const response = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/profile",
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );

        if (!response.ok) {
          // Most likely still throttled and Google extended the window. Leave
          // the row alone; the next tick tries again.
          const text = await response.text();
          logger.warn("[RECONCILE] cooldown resume probe failed", {
            tenantId: row.tenantId, status: response.status, body: text.slice(0, 200),
          });
          if (response.status === 429) {
            await recordQuotaError(row.tenantId, { status: 429, body: safeJson(text) });
          }
          return { resumed: false };
        }

        const profile = (await response.json()) as { historyId?: string };

        // Clear before emitting: the notification path checks the cooldown and
        // would otherwise ack-and-drop the very diff we're trying to resume.
        await clearCooldown(row.tenantId);

        if (profile.historyId) {
          await inngest.send({
            name: "gmail/webhook.notification",
            data: { tenantId: row.tenantId, incomingHistoryId: profile.historyId },
          });
        }

        logger.info("[RECONCILE] resumed mailbox after quota cooldown", {
          tenantId: row.tenantId,
          emailAddress: row.emailAddress,
          historyId: profile.historyId,
        });
        return { resumed: true };
      });
    }

    return {
      stalledSyncs: stalledSyncs.length,
      stalledJobs: stalledJobs.length,
      stalledHydrations: stalledHydrations.length,
      cooldownsResumed: expiredCooldowns.length,
    };
  },
);

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
