import { corsair } from "@repo/corsair";
import { db, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";

import {CATEGORY_TO_GMAIL_QUERY, CATEGORY_TO_GMAIL_LABEL, ALL_CATEGORIES, extractHeader} from './metadata.ts';
import { withGmailRetry } from './retry.ts';
import { normalizeMessageId } from './message-id.ts';
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
        })),
      )
      .onConflictDoUpdate({
        target: messageMetadata.entityId,
        set: {
          userId: sql`excluded.user_id`,
          gmailLabels: sql`excluded.gmail_labels`,
          category: sql`excluded.category`,
          sender: sql`excluded.sender`,
          subject: sql`excluded.subject`,
          snippet: sql`excluded.snippet`,
          isUnread: sql`excluded.is_unread`,
          isInInbox: sql`excluded.is_in_inbox`,
          isStarred: sql`excluded.is_starred`,
          isImportant: sql`excluded.is_important`,
          receivedAt: sql`excluded.received_at`,
          threadId: sql`excluded.thread_id`,
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

interface RawGmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: unknown;
}

function buildMetadataInput(userId: string, msg: RawGmailMessage): MetadataInput | null {
  if (!msg.id) return null;

  const raw = msg as Record<string, unknown>;
  const sender = extractHeader(raw, "From");
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
    subject,
    snippet,
    category,
    ...flags,
    receivedAt,
    threadId: msg.threadId,
    rfc822MessageId: rfc822MessageId || undefined,
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


// Gmail's per-user quota is 250 units/sec and threads.get costs 5 units, so
// firing all ~100 threads per page at once (500 units) reliably triggers 429s.
// A single rejected call in Promise.all previously aborted the whole
// syncAllEmails call (and therefore the rest of pagination) — this limiter
// caps concurrency and isolates per-thread failures so one bad/rate-limited
// thread just gets skipped (and logged) instead of truncating the sync.
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
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
 */
export async function syncCategoryPage(
  userId: string,
  category: string,
  pageToken?: string,
): Promise<{ processed: number; nextPageToken?: string }> {
  // Drafts are a separate Gmail resource, not a label query — they need the
  // draft id (which is not the message id) to be editable later.
  if (category === "DRAFT") {
    const { syncDraftsPage } = await import("./drafts.ts");
    return syncDraftsPage(userId, pageToken);
  }

  const tenant = corsair.withTenant(userId);
  const gmailQueryTerm = CATEGORY_TO_GMAIL_QUERY[category];
  const labelId = CATEGORY_TO_GMAIL_LABEL[category];

  const result = await withGmailRetry<{
    threads?: Array<{ id?: string }>;
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

  const detailed = await mapWithConcurrency(
    result.threads ?? [],
    10,
    (t: any) =>
      withGmailRetry(`threads.get ${t.id}`, () =>
        tenant.gmail.api.threads.get({
          id: t.id,
          format: "metadata",
        }),
        { tenantId: userId, trigger: "sync" },
      ),
  );

  const messages: RawGmailMessage[] = detailed
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .flatMap((t: any) => (t.messages ?? []).filter((m: any) => m?.id));

  await processMessages(userId, messages);

  return {
    processed: messages.length,
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
): Promise<number> {
  let pageToken: string | undefined;
  let total = runningTotal;

  do {
    const { processed, nextPageToken } = await syncCategoryPage(
      userId,
      category,
      pageToken,
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
 */
export async function triggerGmailSync(userId: string): Promise<void> {
  if (process.env.INNGEST_EVENT_KEY) {
    await markSyncQueued(userId);
    const { inngest } = await import("@repo/inngest");
    await inngest.send({ name: "gmail/sync.requested", data: { userId } });
    logger.info("[SYNC] enqueued durable gmail sync", { userId });
    return;
  }
  logger.warn(
    "[SYNC] INNGEST_EVENT_KEY not set — running in-process sync (not durable/resumable)",
    { userId },
  );
  const estimatedTotal = await estimateMailboxTotal(userId);
  await markSyncRunning(userId, estimatedTotal);
  try {
    // Report progress per page so the waiting screen moves on this path too.
    // categoryIndex is real (the waiting screen renders a "step N of 9" stage
    // from it); the page token stays null, honestly, because unlike
    // gmailInitialSync this path genuinely cannot resume — a restart mid-sync
    // starts over.
    await syncMailbox(userId, (categoryIndex) =>
      updateSyncProgress(userId, { categoryIndex, pageToken: null }),
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
): Promise<number> {
  let total = 0;
  for (const [index, category] of ALL_CATEGORIES.entries()) {
    // Isolate each category so an exhausted-retry failure in one (e.g. a
    // large PROMOTIONS folder) doesn't abort the remaining categories.
    try {
      // Report the index of the category being worked on, so a stalled or
      // failed category still leaves the waiting screen's stage label correct.
      total = await syncAllEmails(userId, category, total, onPage && (() => onPage(index)));
    } catch (err) {
      logger.error("[SYNC] syncAllEmails category failed, continuing", {
        userId, category, error: String(err),
      });
    }
  }
  return total;
}