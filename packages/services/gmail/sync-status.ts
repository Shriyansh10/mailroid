import { corsair } from "@repo/corsair";
import { db, eq } from "@repo/database";
import { gmailSyncStatus } from "@repo/database/models/gmail-sync-status";
import { logger } from "@repo/logger";

import { ALL_CATEGORIES } from "./metadata.ts";
import { withGmailRetry } from "./retry.ts";

// Persisted checkpoint for the durable initial sync (see initial-sync.ts).
// Before this existed, gmailInitialSync returned `{ done: true }` straight to
// Inngest and that was the only place the fact ever lived — nothing in the DB
// recorded whether a user's sync had ever completed, so the UI had nothing to
// poll and couldn't gate anything on it.

export type SyncCursor = { categoryIndex: number; pageToken: string | null };

/**
 * Written when a sync is enqueued but hasn't started running yet. Initial
 * sync runs at concurrency 1, so a second user connecting Gmail while the
 * first is mid-sync sits behind it — without a distinct `queued` state the
 * waiting screen would show no progress for the entire wait and look dead.
 */
export async function markSyncQueued(userId: string): Promise<void> {
  await db
    .insert(gmailSyncStatus)
    .values({ userId, status: "queued", processed: 0, cursor: null, estimatedTotal: null, startedAt: null })
    .onConflictDoUpdate({
      target: gmailSyncStatus.userId,
      set: {
        status: "queued",
        cursor: null,
        processed: 0,
        estimatedTotal: null,
        startedAt: null,
        updatedAt: new Date(),
      },
    });
}

/** Written once, by the first run only — continuation runs must never call this. */
export async function markSyncRunning(userId: string, estimatedTotal: number | null): Promise<void> {
  await db
    .insert(gmailSyncStatus)
    .values({ userId, status: "running", processed: 0, estimatedTotal, startedAt: new Date() })
    .onConflictDoUpdate({
      target: gmailSyncStatus.userId,
      set: { status: "running", estimatedTotal, startedAt: new Date(), updatedAt: new Date() },
    });
}

/** Called after every page. Never touches `status` — only the run that exhausts pagination does. */
export async function updateSyncProgress(
  userId: string,
  cursor: SyncCursor,
  processed: number,
): Promise<void> {
  await db
    .update(gmailSyncStatus)
    .set({ cursor, processed, updatedAt: new Date() })
    .where(eq(gmailSyncStatus.userId, userId));
}

/** Written only by the run whose while-loop exits with nextPageToken == null on every category. */
export async function markSyncComplete(userId: string, processed: number): Promise<void> {
  await db
    .update(gmailSyncStatus)
    .set({ status: "complete", processed, cursor: null, updatedAt: new Date() })
    .where(eq(gmailSyncStatus.userId, userId));
}

/** Written by onFailure once Inngest's retries are exhausted. */
export async function markSyncFailed(userId: string): Promise<void> {
  await db
    .update(gmailSyncStatus)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(gmailSyncStatus.userId, userId));
}

export async function getSyncStatus(userId: string) {
  const [row] = await db
    .select()
    .from(gmailSyncStatus)
    .where(eq(gmailSyncStatus.userId, userId))
    .limit(1);
  return row ?? null;
}

// Gmail label IDs, distinct from CATEGORY_TO_GMAIL_QUERY (search terms) —
// labels.get needs the actual label id, not a `category:` search operator.
const CATEGORY_TO_GMAIL_LABEL_ID: Record<string, string> = {
  PRIMARY: "CATEGORY_PERSONAL",
  SOCIAL: "CATEGORY_SOCIAL",
  PROMOTIONS: "CATEGORY_PROMOTIONS",
  UPDATES: "CATEGORY_UPDATES",
  FORUMS: "CATEGORY_FORUMS",
  SENT: "SENT",
};

/**
 * Display-only mailbox size estimate — one labels.get call per category (6
 * Gmail quota units total, at kickoff). NEVER used to decide completion:
 * sync queries by `q: category:x` (search semantics) while a label's
 * messagesTotal counts label membership, and the two drift by a few
 * percent — gating completion on `processed >= estimatedTotal` could leave
 * the UI waiting on a number the sync's own count never exactly reaches.
 * Completion is always `nextPageToken == null` on every category.
 */
export async function estimateMailboxTotal(userId: string): Promise<number | null> {
  const tenant = corsair.withTenant(userId);
  let total = 0;
  let anySucceeded = false;

  for (const category of ALL_CATEGORIES) {
    const labelId = CATEGORY_TO_GMAIL_LABEL_ID[category];
    if (!labelId) continue;
    try {
      const label = await withGmailRetry(`labels.get ${labelId}`, () =>
        tenant.gmail.api.labels.get({ id: labelId }),
      );
      total += (label as { messagesTotal?: number })?.messagesTotal ?? 0;
      anySucceeded = true;
    } catch (err) {
      logger.error("[SYNC] estimateMailboxTotal label fetch failed", {
        userId, category, labelId, error: String(err),
      });
    }
  }

  return anySucceeded ? total : null;
}
