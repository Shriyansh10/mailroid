/**
 * The write half of sync-failures.ts, split out so sync-metadata.ts can record a
 * failure without importing the retry worker (which imports sync-metadata.ts).
 */

import { db } from "@repo/database";
import { gmailSyncFailures } from "@repo/database/models/gmail-sync-failures";

import { getCooldown } from "./quota-cooldown.ts";
import { describeSyncFailure, nextStateAfterFailure } from "./sync-failures-policy.ts";

export type SyncFailureSource = "initial-sync" | "operator";

/**
 * Record (or refresh) a failed thread fetch as owed a retry.
 *
 * Throws on a write failure, on purpose: the caller is a sync page step, and a
 * failed step is retried by Inngest. Swallowing here is how a lost thread would
 * become an unrecorded lost thread.
 */
export async function recordSyncFailure(
  tenantId: string,
  threadId: string,
  err: unknown,
  source: SyncFailureSource,
): Promise<void> {
  const now = new Date();
  const cooldown = await getCooldown(tenantId).catch(() => null);
  const state = nextStateAfterFailure(err, 0, now, cooldown?.until);

  await db
    .insert(gmailSyncFailures)
    .values({
      tenantId,
      threadId,
      source,
      kind: state.kind,
      status: state.status,
      attempts: 0,
      nextAttemptAt: state.nextAttemptAt,
      lastError: describeSyncFailure(err),
    })
    .onConflictDoUpdate({
      target: [gmailSyncFailures.tenantId, gmailSyncFailures.threadId],
      // A fresh failure of a thread we already track: owed a retry again, but
      // attempts already spent are kept — a page retried by Inngest must not
      // reset the count.
      set: {
        kind: state.kind,
        status: state.status,
        nextAttemptAt: state.nextAttemptAt,
        lastError: describeSyncFailure(err),
        updatedAt: now,
      },
    });
}
