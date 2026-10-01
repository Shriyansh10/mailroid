/**
 * Durable record and retry of threads a sync failed to fetch.
 *
 * Initial sync records a row the moment a thread fetch fails (recordSyncFailure,
 * awaited inside the page's step — if the write fails, the step fails and
 * Inngest retries the page, so a failure is never silently forgotten). Rows are
 * retried by gmailSyncFailuresRetry, one mailbox at a time, through the normal
 * paced request layer.
 *
 * GUARANTEED WAKE-UP. gmailSyncFailuresSweep runs every 15 minutes and selects
 * only rows whose next_attempt_at has passed, so a row waiting out a cooldown
 * costs nothing until its window ends, and is picked up within 15 minutes after.
 *
 * Operator recovery: send `gmail/sync-failures.retry` with
 * `{ userId, threadIds }` — the ids are upserted as pending (resetting a
 * terminal row) and retried. This is how a known set of missing threads is
 * fetched without resyncing the mailbox.
 */

import { corsair } from "@repo/corsair";
import { and, asc, db, eq, lte, sql } from "@repo/database";
import { gmailSyncFailures } from "@repo/database/models/gmail-sync-failures";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { inngest } from "@repo/inngest";
import { errorFields, logger } from "@repo/logger";

import { assertSyncAllowed, getCooldown } from "./quota-cooldown.ts";
import { withGmailRetry } from "./retry.ts";
import { processMessages, type RawGmailMessage } from "./sync-metadata.ts";
import {
  describeSyncFailure,
  kindOfSyncFailure,
  nextStateAfterFailure,
} from "./sync-failures-policy.ts";

// The recorder lives in its own module (see there); re-exported so callers have one entry point.
export { recordSyncFailure, type SyncFailureSource } from "./sync-failures-record.ts";

/** Rows retried per worker run; the sweep re-sends while more are due. */
const RETRY_BATCH = 50;

/** Operator: owe these threads a retry now, resetting any terminal state. */
async function enqueueOperatorThreads(tenantId: string, threadIds: string[]): Promise<void> {
  if (threadIds.length === 0) return;
  const now = new Date();
  await db
    .insert(gmailSyncFailures)
    .values(
      threadIds.map((threadId) => ({
        tenantId,
        threadId,
        source: "operator",
        kind: "other",
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [gmailSyncFailures.tenantId, gmailSyncFailures.threadId],
      // A deliberate operator action: fresh attempts, due now. A row already
      // `done` is re-checked too — the pre-check below costs no Gmail call.
      set: { status: "pending", attempts: 0, nextAttemptAt: now, updatedAt: now },
    });
}

/** Does this mailbox already hold any message from this thread? */
async function threadIsStored(tenantId: string, threadId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(messageMetadata)
    .where(and(eq(messageMetadata.userId, tenantId), eq(messageMetadata.threadId, threadId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Move a row out of `pending`. Conditional on it still being pending, so a
 * stale or duplicate worker can never overwrite a state another run decided.
 */
async function settle(
  tenantId: string,
  threadId: string,
  set: Partial<typeof gmailSyncFailures.$inferInsert>,
): Promise<boolean> {
  const updated = await db
    .update(gmailSyncFailures)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(gmailSyncFailures.tenantId, tenantId),
        eq(gmailSyncFailures.threadId, threadId),
        eq(gmailSyncFailures.status, "pending"),
      ),
    )
    .returning({ threadId: gmailSyncFailures.threadId });
  return updated.length > 0;
}

export type RetryOutcome = "done-already-stored" | "done-fetched" | "pending" | "terminal" | "lost-race";

/** One row: pre-check, fetch through the paced layer, store, settle. */
async function retryOne(
  tenantId: string,
  threadId: string,
  priorAttempts: number,
): Promise<{ outcome: RetryOutcome; kind?: string }> {
  // Free: no Gmail call when the thread is already here (stored by a later
  // sync, a webhook, or an earlier run of this worker).
  if (await threadIsStored(tenantId, threadId)) {
    const settled = await settle(tenantId, threadId, { status: "done", lastError: null });
    return { outcome: settled ? "done-already-stored" : "lost-race" };
  }

  const tenant = corsair.withTenant(tenantId);
  try {
    const thread = (await withGmailRetry(
      `threads.get ${threadId}`,
      () => tenant.gmail.api.threads.get({ id: threadId, format: "metadata" }),
      { tenantId, trigger: "sync" },
    )) as { historyId?: string; messages?: RawGmailMessage[] };

    const messages = (thread.messages ?? [])
      .filter((m) => m?.id)
      .map((m) => ({ ...m, threadHistoryId: thread.historyId }));
    await processMessages(tenantId, messages);

    const settled = await settle(tenantId, threadId, { status: "done", lastError: null });
    return { outcome: settled ? "done-fetched" : "lost-race" };
  } catch (err) {
    const cooldown = await getCooldown(tenantId).catch(() => null);
    const state = nextStateAfterFailure(err, priorAttempts, new Date(), cooldown?.until);
    const settled = await settle(tenantId, threadId, {
      kind: state.kind,
      status: state.status,
      attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt,
      lastError: describeSyncFailure(err),
    });
    // A terminal row is an operator finding: log it in full, once.
    if (state.status === "terminal") {
      logger.error("[SYNC_FAILURES] thread given up on", {
        tenantId,
        threadId,
        kind: state.kind,
        attempts: state.attempts,
        ...errorFields(err),
      });
    }
    return { outcome: settled ? (state.status === "terminal" ? "terminal" : "pending") : "lost-race", kind: state.kind };
  }
}

/**
 * Retry one mailbox's due failures. Serialised per mailbox, so two runs can't
 * fetch the same thread at once; the conditional settle covers anything else.
 */
export const gmailSyncFailuresRetry = inngest.createFunction(
  {
    id: "gmail-sync-failures-retry",
    concurrency: [{ key: "event.data.userId", limit: 1 }],
    retries: 2,
  },
  { event: "gmail/sync-failures.retry" },
  async ({ event, step }) => {
    const tenantId: string = event.data.userId;
    const threadIds: string[] = Array.isArray(event.data.threadIds) ? event.data.threadIds : [];

    if (threadIds.length > 0) {
      await step.run("enqueue-operator-threads", () => enqueueOperatorThreads(tenantId, threadIds));
    }

    // One gate check for the whole run: paused, auth-dead or cooling mailboxes
    // make no calls. Rows stay pending; the sweep brings them back when due.
    const allowed = await step.run("gate", async () => {
      try {
        await assertSyncAllowed(tenantId, { trigger: "sync", operation: "sync-failures.retry" });
        return true;
      } catch (err) {
        logger.info("[SYNC_FAILURES] mailbox not syncable now, leaving rows pending", {
          tenantId,
          kind: kindOfSyncFailure(err),
        });
        return false;
      }
    });
    if (!allowed) return { tenantId, skipped: "gate" };

    const due = await step.run("select-due", () =>
      db
        .select({ threadId: gmailSyncFailures.threadId, attempts: gmailSyncFailures.attempts })
        .from(gmailSyncFailures)
        .where(
          and(
            eq(gmailSyncFailures.tenantId, tenantId),
            eq(gmailSyncFailures.status, "pending"),
            lte(gmailSyncFailures.nextAttemptAt, new Date()),
          ),
        )
        .orderBy(asc(gmailSyncFailures.nextAttemptAt))
        .limit(RETRY_BATCH),
    );

    const tally: Record<string, number> = {};
    for (const row of due) {
      const result = await step.run(`retry-${row.threadId}`, () =>
        retryOne(tenantId, row.threadId, row.attempts),
      );
      tally[result.outcome] = (tally[result.outcome] ?? 0) + 1;
      // The mailbox just hit its quota: every remaining fetch would be refused
      // by the gate anyway. Stop; the rows are already scheduled past the window.
      if (result.kind === "quota") break;
    }

    // One summary line per run, not one per thread.
    logger.info("[SYNC_FAILURES] retry run", { tenantId, due: due.length, ...tally });
    return { tenantId, due: due.length, tally };
  },
);

/**
 * Every 15 minutes: one retry event per mailbox that has rows due now.
 * Selects only due rows, so a mailbox waiting out a cooldown generates nothing.
 */
export const gmailSyncFailuresSweep = inngest.createFunction(
  { id: "gmail-sync-failures-sweep" },
  [{ cron: "*/15 * * * *" }, { event: "gmail/sync-failures.sweep" }],
  async ({ step }) => {
    const tenants = await step.run("find-due-mailboxes", async () => {
      const rows = await db
        .selectDistinct({ tenantId: gmailSyncFailures.tenantId })
        .from(gmailSyncFailures)
        .where(
          and(
            eq(gmailSyncFailures.status, "pending"),
            lte(gmailSyncFailures.nextAttemptAt, new Date()),
          ),
        );
      return rows.map((r) => r.tenantId);
    });

    if (tenants.length > 0) {
      await step.sendEvent(
        "retry-due-mailboxes",
        tenants.map((userId) => ({ name: "gmail/sync-failures.retry", data: { userId } })),
      );
    }
    return { mailboxes: tenants.length };
  },
);

/** For initial sync's completion step: does this mailbox owe any retries? */
export async function hasPendingSyncFailures(tenantId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(gmailSyncFailures)
    .where(and(eq(gmailSyncFailures.tenantId, tenantId), eq(gmailSyncFailures.status, "pending")))
    .limit(1);
  return Boolean(row);
}

