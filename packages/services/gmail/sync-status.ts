import { corsair } from "@repo/corsair";
import { db, eq, sql } from "@repo/database";
import { gmailSyncStatus } from "@repo/database/models/gmail-sync-status";
import { messageMetadata } from "@repo/database/models/message-metadata";
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

/**
 * How many distinct emails this user actually has, counted from the rows the
 * sync wrote.
 *
 * This exists because the sync's own page counter cannot be trusted as a
 * progress number. syncCategoryPage lists *threads* but counts *messages*
 * (`processed: messages.length`), and threads.get returns every message in a
 * thread regardless of which label it carries — so a conversation you replied
 * to is counted once under PRIMARY and again under SENT, and a thread that
 * merely contains one personal message drags its promo/update siblings into
 * the PRIMARY tally too. Summed across nine categories that overshot the real
 * mailbox by ~30%, which is how the waiting screen ended up rendering
 * "Imported 1,998 / ~1,561 emails".
 *
 * The DB never had that problem — upsertMessageMetadataBatch dedupes on
 * entityId — so counting rows gives the deduped truth in the same unit as
 * estimateMailboxTotal's denominator (distinct messages, not thread
 * expansions). One indexed count per page is negligible beside the 100-thread
 * threads.get fan-out that precedes it.
 *
 * Archived rows are included on purpose: they are emails we hold and imported,
 * and excluding them would make the number visibly walk backwards when a
 * Gmail purge lands mid-sync.
 */
export async function countSyncedMessages(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(messageMetadata)
    .where(eq(messageMetadata.userId, userId));
  return Number(row?.count ?? 0);
}

/**
 * Called after every page. Never touches `status` — only the run that exhausts
 * pagination does. Returns the freshly counted total so callers can log the
 * real number rather than their own inflated accumulator.
 */
export async function updateSyncProgress(
  userId: string,
  cursor: SyncCursor,
): Promise<number> {
  const processed = await countSyncedMessages(userId);
  await db
    .update(gmailSyncStatus)
    .set({ cursor, processed, updatedAt: new Date() })
    .where(eq(gmailSyncStatus.userId, userId));
  return processed;
}

/** Written only by the run whose while-loop exits with nextPageToken == null on every category. */
export async function markSyncComplete(userId: string): Promise<number> {
  const processed = await countSyncedMessages(userId);
  await db
    .update(gmailSyncStatus)
    .set({ status: "complete", processed, cursor: null, updatedAt: new Date() })
    .where(eq(gmailSyncStatus.userId, userId));
  return processed;
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
  // Now that the sync walks these too, they belong in the estimate — otherwise
  // the progress bar's denominator is short by a whole mailbox's worth of spam.
  SPAM: "SPAM",
  TRASH: "TRASH",
  DRAFT: "DRAFT",
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
