import { corsair } from "@repo/corsair";
import { db, sql, eq, and, inArray } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";

import {CATEGORY_TO_GMAIL_QUERY, CATEGORY_TO_GMAIL_LABEL, ALL_CATEGORIES, extractHeader} from './metadata.ts';
import { withGmailRetry } from './retry.ts';
import { normalizeMessageId } from './message-id.ts';
import { recordSyncFailure } from "./sync-failures-record.ts";
import {
  markSyncQueued,
  markSyncRunning,
  markSyncComplete,
  markSyncFailed,
  updateSyncProgress,
  estimateMailboxTotal,
} from './sync-status.ts';

// Postgres has a bind-parameter ceiling, and one round trip per row defeats
// the point of batching — chunk large pages into fixed-size upsert statements.
const UPSERT_BATCH_SIZE = 100;

// ── Category mapping ──────────────────────────────────────────────────

/**
 * Label → category, in PRECEDENCE order (first match wins).
 *
 * The order is the whole point. Gmail returns labelIds in no guaranteed order,
 * and a message routinely carries several of these at once — a spam message is
 * very often ["UNREAD", "CATEGORY_PROMOTIONS", "SPAM"]. Scanning the message's
 * own label array and taking the first hit therefore filed the same email as
 * PROMOTIONS or SPAM depending on the order Gmail happened to serialise it in,
 * which is why the Spam view could stay empty while Gmail showed 48 messages.
 *
 * Location labels (DRAFT/SPAM/TRASH/SENT) beat the CATEGORY_* tabs because they
 * describe which folder the message is *in*; the tab is only meaningful for
 * mail that is actually in the inbox.
 */
const CATEGORY_PRECEDENCE: Array<[label: string, category: string]> = [
  ["DRAFT", "DRAFT"],
  ["SPAM", "SPAM"],
  ["TRASH", "TRASH"],
  ["SENT", "SENT"],

  ["CATEGORY_PERSONAL", "PRIMARY"],
  ["CATEGORY_PROMOTIONS", "PROMOTIONS"],
  ["CATEGORY_SOCIAL", "SOCIAL"],
  ["CATEGORY_UPDATES", "UPDATES"],
  ["CATEGORY_FORUMS", "FORUMS"],
];

/**
 * Our category name → the Gmail tab label that produces it, for the five
 * CATEGORY_* tabs only (SENT/SPAM/TRASH/DRAFT are locations, not tabs, and are
 * not settable this way).
 *
 * Derived from CATEGORY_PRECEDENCE rather than written out a second time: the
 * two directions must agree, and a hand-copied inverse is exactly the kind of
 * pair that drifts silently when someone adds a category to one of them.
 *
 * Note these are Gmail *label ids*, which is what threads.modify takes.
 * CATEGORY_TO_GMAIL_QUERY in metadata.ts looks similar but holds *search query*
 * terms ("personal"), which are not interchangeable with these.
 */
export const CATEGORY_TAB_LABELS: Record<string, string> = Object.fromEntries(
  CATEGORY_PRECEDENCE.filter(([label]) => label.startsWith("CATEGORY_")).map(
    ([label, category]) => [category, label],
  ),
);

export function deriveCategory(labels: string[]): string {
  if (!Array.isArray(labels) || labels.length === 0) {
    logger.debug("[CATEGORY] deriveCategory - no labels, returning OTHER");
    return "OTHER";
  }
  // Iterate OUR precedence list against the message's labels — never the
  // message's label array against our map (see the comment above).
  const set = new Set(labels);
  for (const [label, category] of CATEGORY_PRECEDENCE) {
    if (set.has(label)) return category;
  }
  logger.debug("[CATEGORY] deriveCategory - no match in known labels, returning OTHER", { labels });
  return "OTHER";
}

// ── Flag derivation ───────────────────────────────────────────────────

export function deriveFlags(labels: string[]): {
  isUnread: boolean;
  isInInbox: boolean;
  isStarred: boolean;
  isImportant: boolean;
} {
  const set = new Set(labels ?? []);
  const flags = {
    isUnread: set.has("UNREAD"),
    isInInbox: set.has("INBOX"),
    isStarred: set.has("STARRED"),
    isImportant: set.has("IMPORTANT"),
  };
  return flags;
}

// ── Upsert ────────────────────────────────────────────────────────────

export interface MetadataInput {
  entityId: string;
  userId: string;
  gmailLabels: string[];
  category: string;
  isUnread: boolean;
  sender?: string;
  /** The `To` header — see the column comment on message-metadata.ts. */
  recipient?: string;
subject?: string;
snippet?: string;
  isInInbox: boolean;
  isStarred: boolean;
  isImportant: boolean;
  receivedAt?: Date;
  threadId?: string;
  /** Gmail draft resource id. Only the drafts sync path sets this. */
  draftId?: string;
  /**
   * Normalised RFC822 Message-ID. Shared across every mailbox holding this
   * message, unlike entityId/threadId — see message-id.ts.
   */
  rfc822MessageId?: string;
  /**
   * P-4, docs/gmail-rate-limit-boundary.md §13. The THREAD's historyId from
   * the threads.list page this message's thread was fetched from — see the
   * column comment on message-metadata.ts. Stamped uniformly onto every
   * message of one thread by syncCategoryPage; nothing else should set this.
   */
  threadHistoryId?: string;
}

export async function upsertMessageMetadata(input: MetadataInput): Promise<void> {
  await upsertMessageMetadataBatch([input]);
}

/**
 * Batch upsert — one INSERT ... ON CONFLICT statement per chunk of rows,
 * instead of one round trip per email. `excluded.*` refers to the row that
 * lost the conflict, which is what makes a single multi-row statement upsert
 * every row correctly (Drizzle's per-column `set` on a single-row upsert
 * would otherwise just repeat the first row's values for the whole batch).
 */
export async function upsertMessageMetadataBatch(inputs: MetadataInput[]): Promise<void> {
  if (inputs.length === 0) return;

  for (let i = 0; i < inputs.length; i += UPSERT_BATCH_SIZE) {
    const chunk = inputs.slice(i, i + UPSERT_BATCH_SIZE);
    await db
      .insert(messageMetadata)
      .values(
        chunk.map((input) => ({
          entityId: input.entityId,
          userId: input.userId,
          gmailLabels: input.gmailLabels,
          category: input.category as any,
          sender: input.sender,
          recipient: input.recipient,
          subject: input.subject,
          snippet: input.snippet,
          isUnread: input.isUnread,
          isInInbox: input.isInInbox,
          isStarred: input.isStarred,
          isImportant: input.isImportant,
          receivedAt: input.receivedAt,
          threadId: input.threadId,
          draftId: input.draftId,
          rfc822MessageId: input.rfc822MessageId,
          threadHistoryId: input.threadHistoryId,
        })),
      )
      .onConflictDoUpdate({
        target: messageMetadata.entityId,
        set: {
          userId: sql`excluded.user_id`,
          gmailLabels: sql`excluded.gmail_labels`,
          category: sql`excluded.category`,
          sender: sql`excluded.sender`,
          recipient: sql`excluded.recipient`,
          subject: sql`excluded.subject`,
          snippet: sql`excluded.snippet`,
          isUnread: sql`excluded.is_unread`,
          isInInbox: sql`excluded.is_in_inbox`,
          isStarred: sql`excluded.is_starred`,
          isImportant: sql`excluded.is_important`,
          receivedAt: sql`excluded.received_at`,
          threadId: sql`excluded.thread_id`,
          // COALESCE like draftId/rfc822MessageId below: this batch only ever
          // carries a value when it came from a real threads.get (P-4), never
          // from a path that touches the row for some other reason (e.g. the
          // webhook diff's per-message ingest), and a bare overwrite there
          // would null out a value P-4's own next comparison depends on.
          threadHistoryId: sql`coalesce(excluded.thread_history_id, ${messageMetadata.threadHistoryId})`,
          // COALESCE, not a plain overwrite: a draft's message can also be
          // seen by a label/thread sync that knows nothing about draft ids,
          // and a bare `excluded.draft_id` would null out the id we need to
          // edit or send that draft later.
          draftId: sql`coalesce(excluded.draft_id, ${messageMetadata.draftId})`,
          // COALESCE for the same reason as draftId: not every path that
          // touches a row carries the header (drafts have none until sent),
          // and nulling out a captured id silently un-links a guest's view of
          // an existing meeting.
          rfc822MessageId: sql`coalesce(excluded.rfc822_message_id, ${messageMetadata.rfc822MessageId})`,
          updatedAt: new Date(),
        },
      });
  }

  logger.debug("[DB] upsertMessageMetadataBatch completed", {
    count: inputs.length, batches: Math.ceil(inputs.length / UPSERT_BATCH_SIZE),
  });
}

// ── Single pipeline entry point ───────────────────────────────────────
//
// syncCategoryPage already calls threads.get(format:"metadata"), whose
// response contains every field used below (From/Subject headers, snippet,
// labelIds, internalDate, threadId). Building the row from that response
// instead of re-fetching messages.get(format:"full") per message removes
// ~1 redundant Gmail API call (and a full-body download) per email synced.

export interface RawGmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: unknown;
  /** P-4 — see MetadataInput.threadHistoryId. Not a field Gmail's message
   *  resource carries; syncCategoryPage stamps it in from the thread envelope
   *  before calling processMessages. */
  threadHistoryId?: string;
}

function buildMetadataInput(userId: string, msg: RawGmailMessage): MetadataInput | null {
  if (!msg.id) return null;

  const raw = msg as Record<string, unknown>;
  const sender = extractHeader(raw, "From");
  const recipient = extractHeader(raw, "To");
  const subject = extractHeader(raw, "Subject");
  // threads.get(format:"metadata") returns the full header set — no
  // metadataHeaders restriction is set anywhere — so this path can capture the
  // Message-ID too. It matters that it does: this is the walk that covers the
  // bulk of a large mailbox, and a thread it imported would otherwise have no
  // Message-ID to match a guest's meeting against.
  const rfc822MessageId = normalizeMessageId(extractHeader(raw, "Message-ID"));
  const snippet = msg.snippet ?? "";
  const labels: string[] = msg.labelIds ?? [];
  const internalDate = Number(msg.internalDate);
  const receivedAt = isNaN(internalDate) ? undefined : new Date(internalDate);
  const category = deriveCategory(labels);
  const flags = deriveFlags(labels);

  return {
    entityId: msg.id,
    userId,
    gmailLabels: labels,
    sender,
    recipient,
    subject,
    snippet,
    category,
    ...flags,
    receivedAt,
    threadId: msg.threadId,
    rfc822MessageId: rfc822MessageId || undefined,
    threadHistoryId: msg.threadHistoryId,
  };
}

export async function processMessages(
  userId: string,
  messages: RawGmailMessage[],
): Promise<void> {
  logger.info("[SERVICE] processMessages batch", { userId, entityCount: messages.length });

  const rows = messages
    .map((msg) => buildMetadataInput(userId, msg))
    .filter((row): row is MetadataInput => row !== null);

  await upsertMessageMetadataBatch(rows);

  logger.info("[SERVICE] processMessages batch completed", { userId, entityCount: rows.length });
}


// Bounded worker pool. TWO JOBS, AND QUOTA PACING IS NO LONGER ONE OF THEM.
//
//   1. Bound how many requests are in flight — Gmail enforces a per-user
//      CONCURRENT REQUEST limit separately from the quota-unit budget, and many
//      parallel requests for one mailbox can 429 on that alone.
//   2. Isolate per-item failures. A single rejection inside Promise.all used to
//      abort the whole syncAllEmails call and the rest of pagination with it;
//      here one bad thread is skipped and logged instead of truncating the sync.
//
// Rate is `quota-limiter.ts`'s job now, and the two do not substitute for each
// other: the limiter controls units-over-time, this controls simultaneity.
//
// THE NUMBERS THAT USED TO BE IN THIS COMMENT WERE WRONG BY 8x, and they are
// why a concurrency of 10 looked safe. It claimed threads.get costs 5 units and
// a page therefore spends 500. Per notes/reference/gmail-quota-units.md,
// verified against Google's published table: threads.get is **40** units, so one
// 100-thread page spends 100 x 40 + 10 = **4,010 units** — roughly 40 seconds of
// a mailbox's 6,000-units-per-minute budget, not two-thirds of a second.
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  /**
   * Called, and AWAITED, for each item that failed. If it throws, the whole
   * call rejects — deliberately: the caller is a durable step, and a failure
   * that cannot even be recorded must fail the step so it is retried, rather
   * than be skipped with no trace.
   */
  onError?: (item: T, err: unknown) => Promise<void>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await fn(items[current]!);
      } catch (err) {
        logger.error("[SYNC] thread fetch failed, skipping", { error: String(err) });
        if (onError) await onError(items[current]!, err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Syncs a SINGLE page of one category and returns the next page token.
 *
 * This is the atomic unit of work for the durable Inngest sync — each call
 * is wrapped in its own `step.run`, so Inngest checkpoints after every page
 * and a redeploy resumes from the exact page it left off (via the returned
 * nextPageToken), rather than restarting the whole mailbox.
 *
 * P-4 (docs/gmail-rate-limit-boundary.md §13): threads.list is cheap (10
 * units for up to 100 threads) but ALSO reports each thread's current
 * historyId, and threads.get is the expensive part (40 units each) — so the
 * list response is diffed against what's already stored, per thread, BEFORE
 * mapWithConcurrency spends a single threads.get. The decision, precisely:
 *
 *   not stored             -> fetch   (never synced)
 *   stored, unchanged       -> skip    (nothing in the thread has moved)
 *   stored, changed         -> fetch   (something did)
 *   force=true (any state)  -> fetch   (explicit resync — see triggerGmailSync)
 *
 * `force` exists because "unchanged" is a claim about Gmail's state, not
 * about the shape of the row we'd write — a category-derivation fix or a new
 * column backfill needs every thread re-fetched regardless of historyId, and
 * that is what an operator asking for `gmail:resync`/`gmail:resync-categories`
 * actually means.
 */
export async function syncCategoryPage(
  userId: string,
  category: string,
  pageToken?: string,
  force = false,
): Promise<{ processed: number; skipped: number; nextPageToken?: string }> {
  // Drafts are a separate Gmail resource, not a label query — they need the
  // draft id (which is not the message id) to be editable later.
  if (category === "DRAFT") {
    const { syncDraftsPage } = await import("./drafts.ts");
    const draftResult = await syncDraftsPage(userId, pageToken);
    return { ...draftResult, skipped: 0 };
  }

  const tenant = corsair.withTenant(userId);
  const gmailQueryTerm = CATEGORY_TO_GMAIL_QUERY[category];
  const labelId = CATEGORY_TO_GMAIL_LABEL[category];

  const result = await withGmailRetry<{
    threads?: Array<{ id?: string; historyId?: string }>;
    nextPageToken?: string | null;
  }>(`threads.list ${category}`, () =>
    tenant.gmail.api.threads.list({
      maxResults: 100,
      ...(labelId
        ? {
            labelIds: [labelId],
            // Gmail omits SPAM/TRASH from every listing unless asked. Without
            // this the Spam and Bin views come back permanently empty even
            // though the label filter is correct.
            ...(labelId === "SPAM" || labelId === "TRASH"
              ? { includeSpamTrash: true }
              : {}),
          }
        : gmailQueryTerm
          ? { q: `category:${gmailQueryTerm}` }
          : { labelIds: ["INBOX"] }),
      pageToken,
    }),
    { tenantId: userId, trigger: "sync" },
  );

  const listedThreads = (result.threads ?? []).filter(
    (t): t is { id: string; historyId?: string } => Boolean(t.id),
  );

  let toFetch = listedThreads;
  let skipped = 0;

  if (!force && listedThreads.length > 0) {
    const threadIds = listedThreads.map((t) => t.id);
    // DISTINCT ON: multiple message rows can share a threadId, but
    // syncCategoryPage always stamps the same value onto every one of a
    // thread's messages (below), so any one row is representative.
    const storedRows = await db
      .selectDistinctOn([messageMetadata.threadId], {
        threadId: messageMetadata.threadId,
        threadHistoryId: messageMetadata.threadHistoryId,
      })
      .from(messageMetadata)
      .where(and(eq(messageMetadata.userId, userId), inArray(messageMetadata.threadId, threadIds)));

    const storedByThread = new Map(storedRows.map((r) => [r.threadId, r.threadHistoryId]));

    toFetch = listedThreads.filter((t) => {
      const stored = storedByThread.get(t.id);
      // No stored value (never synced, or synced before this column existed)
      // -> fetch. Stored and equal to the fresh list-page value -> skip.
      // Anything else — including a t.historyId Gmail didn't send, which must
      // not be treated as "unchanged" — falls through to fetch.
      return !(stored !== undefined && stored !== null && t.historyId !== undefined && stored === t.historyId);
    });
    skipped = listedThreads.length - toFetch.length;

    if (skipped > 0) {
      logger.debug("[SYNC] P-4 diff skipped unchanged threads", {
        userId, category, listed: listedThreads.length, fetched: toFetch.length, skipped,
      });
    }
  }

  const detailed = await mapWithConcurrency(
    toFetch,
    // 4, DOWN FROM 10 — and the reason changed, not just the number.
    //
    // Throughput no longer needs concurrency: quota-limiter.ts admits ~1.9
    // threads.get per second (75 units/sec / 40 units), which at ~300ms latency
    // saturates at under two in flight. Ten workers would leave six of them
    // permanently asleep inside acquireQuota for zero gain, which is misleading
    // in a profile and in the logs.
    //
    // What concurrency controls now is RESERVATION DEPTH. Four in flight is
    // 4 x 40 = 160 units of schedule booked ahead, ~2.1s — which fits inside the
    // gap between the background and interactive tolerances, so a UI call
    // arriving mid-sync is still admitted immediately. At ten the depth is 400
    // units (~5.3s) and that same UI call lands squarely on its 2s cap.
    4,
    (t) =>
      withGmailRetry(`threads.get ${t.id}`, () =>
        tenant.gmail.api.threads.get({
          id: t.id,
          format: "metadata",
        }),
        { tenantId: userId, trigger: "sync" },
      ),
    // Every skipped thread is recorded and retried later (sync-failures.ts).
    // Skipping without a record is how mailbox 008 lost seven threads.
    (t, err) => recordSyncFailure(userId, t.id, err, "initial-sync"),
  );

  // Stamped from the LIST page's historyId, not from anything threads.get
  // returns — the list value is what the next page's diff will be compared
  // against, so storing anything else would compare apples to oranges.
  //
  // Zipped against `toFetch` by index BEFORE filtering out failed fetches
  // (mapWithConcurrency leaves `undefined` in place for those, preserving
  // index alignment with its input) — filtering first would shift indices
  // and stamp threads with the wrong neighbour's historyId.
  const messages: RawGmailMessage[] = detailed
    .map((t: any, i: number) => (t ? { thread: t, historyId: toFetch[i]?.historyId } : null))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .flatMap(({ thread, historyId }) =>
      (thread.messages ?? [])
        .filter((m: any) => m?.id)
        .map((m: any) => ({ ...m, threadHistoryId: historyId })),
    );

  await processMessages(userId, messages);

  return {
    processed: messages.length,
    skipped,
    nextPageToken: result.nextPageToken ?? undefined,
  };
}

/**
 * `onPage` is invoked after each page so the in-process path can report
 * progress the same way gmailInitialSync does — without it the onboarding
 * waiting screen sits at "Imported 0 emails" for the entire sync. It takes no
 * arguments: the progress number is counted from the DB by updateSyncProgress,
 * not accumulated here.
 *
 * The returned total is the sum of per-page `processed` counts, which counts
 * thread expansions and therefore double-counts messages shared between
 * categories (see countSyncedMessages). It is a work-done figure for logs and
 * the resync CLI — never show it to a user as a mailbox size.
 */
export async function syncAllEmails(
  userId: string,
  category: string,
  runningTotal = 0,
  onPage?: () => Promise<unknown>,
  force = false,
): Promise<number> {
  let pageToken: string | undefined;
  let total = runningTotal;

  do {
    const { processed, nextPageToken } = await syncCategoryPage(
      userId,
      category,
      pageToken,
      force,
    );
    pageToken = nextPageToken;
    total += processed;
    logger.debug("[SYNC] page complete", { category, processed, total, hasNext: Boolean(pageToken) });
    if (onPage) await onPage();
  } while (pageToken);

  return total;
}

/**
 * Trigger a full-mailbox sync for a user. Prefers the durable, resumable
 * Inngest job (`gmail/sync.requested`) when Inngest is configured; falls back
 * to an in-process syncMailbox so the flow still works in dev or before the
 * INNGEST_* keys are set. This is the single entry point used by the OAuth
 * callback, the gmail.resync tRPC mutation, and the resync CLI.
 *
 * `force` is P-4's escape hatch (docs/gmail-rate-limit-boundary.md §13),
 * threaded all the way down to syncCategoryPage's diff. Defaults false, i.e.
 * the diff is live for every ordinary trigger of this function — OAuth
 * connect on a fresh mailbox has nothing stored yet so it fetches everything
 * regardless, and a later re-trigger benefits from the skip. Pass `force:
 * true` only when the caller genuinely wants every thread re-fetched
 * regardless of whether Gmail reports it unchanged — the admin resync CLI
 * does, deliberately, because "refresh this mailbox" from an operator means
 * "re-derive every row," not "trust the diff."
 */
export async function triggerGmailSync(
  userId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const force = options.force ?? false;

  if (process.env.INNGEST_EVENT_KEY) {
    await markSyncQueued(userId);
    const { inngest } = await import("@repo/inngest");
    await inngest.send({ name: "gmail/sync.requested", data: { userId, force } });
    logger.info("[SYNC] enqueued durable gmail sync", { userId, force });
    return;
  }
  logger.warn(
    "[SYNC] INNGEST_EVENT_KEY not set — running in-process sync (not durable/resumable)",
    { userId, force },
  );
  const estimatedTotal = await estimateMailboxTotal(userId);
  await markSyncRunning(userId, estimatedTotal);
  try {
    // Report progress per page so the waiting screen moves on this path too.
    // categoryIndex is real (the waiting screen renders a "step N of 9" stage
    // from it); the page token stays null, honestly, because unlike
    // gmailInitialSync this path genuinely cannot resume — a restart mid-sync
    // starts over.
    await syncMailbox(
      userId,
      (categoryIndex) => updateSyncProgress(userId, { categoryIndex, pageToken: null }),
      force,
    );
    await markSyncComplete(userId);
  } catch (err) {
    await markSyncFailed(userId);
    throw err;
  }
}

export async function syncMailbox(
  userId: string,
  onPage?: (categoryIndex: number) => Promise<unknown>,
  force = false,
): Promise<number> {
  let total = 0;
  for (const [index, category] of ALL_CATEGORIES.entries()) {
    // Isolate each category so an exhausted-retry failure in one (e.g. a
    // large PROMOTIONS folder) doesn't abort the remaining categories.
    try {
      // Report the index of the category being worked on, so a stalled or
      // failed category still leaves the waiting screen's stage label correct.
      total = await syncAllEmails(userId, category, total, onPage && (() => onPage(index)), force);
    } catch (err) {
      logger.error("[SYNC] syncAllEmails category failed, continuing", {
        userId, category, error: String(err),
      });
    }
  }
  return total;
}