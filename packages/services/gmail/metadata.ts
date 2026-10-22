import { db, eq, and, or, sql, desc, inArray, notInArray, type SQL, type SQLWrapper } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { emails } from "@repo/database/models/emails";
import { logger } from "@repo/logger";
import { listAttachmentsForThreads } from "../attachments/store.ts";
import type { ThreadSummary } from "./model.ts";

/**
 * Attach chips to inbox rows, in place.
 *
 * These list functions are DB-only by design — they never call Gmail and never
 * see a MIME payload — so attachments can only come from the manifest a prior
 * hydration or thread read already stored. One indexed query for the whole
 * page.
 *
 * Non-fatal by construction: chips are an enhancement to a row that is
 * perfectly usable without them, and the inbox must never fail to render
 * because a secondary lookup did.
 *
 * Shared by every list surface rather than inlined, because there are several
 * (category, priority, and the live-Gmail path in index.ts) and the last time
 * one of them was missed the chips silently appeared in some views and not
 * others.
 */
export async function enrichWithAttachments(
  userId: string,
  threads: ThreadSummary[],
): Promise<void> {
  if (threads.length === 0) return;

  try {
    const byThread = await listAttachmentsForThreads(
      userId,
      threads.map((t) => t.threadId).filter(Boolean),
    );

    const awaitingManifest: string[] = [];
    for (const thread of threads) {
      const rows = byThread.get(thread.threadId);
      if (!rows || rows.length === 0) {
        // Flagged by the header heuristic but no manifest yet: the row keeps
        // its paperclip, and the backfill is asked to do these threads first.
        if (thread.hasAttachment === true && thread.threadId) awaitingManifest.push(thread.threadId);
        continue;
      }
      thread.attachments = rows.map((row) => ({
        id: row.id,
        partId: row.partId,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        // Whether the bytes are already in object storage. Metadata, not a
        // download: it lets the UI show a thumbnail only when it costs nothing.
        cached: row.cacheStorageKey !== null,
      }));
    }

    if (awaitingManifest.length > 0) {
      // Fire-and-forget: the list response never waits for the backfill.
      void import("./attachment-manifest-backfill.ts")
        .then(({ requestManifestPriority }) => requestManifestPriority(userId, awaitingManifest))
        .catch((err: unknown) => {
          logger.warn("[ATTACHMENTS] could not request priority manifests", { userId, error: String(err) });
        });
    }
  } catch (err) {
    logger.warn("[ATTACHMENTS] could not enrich inbox rows", {
      userId,
      error: String(err),
    });
  }
}

// Everything the full-mailbox sync walks, in order. SPAM/TRASH/DRAFT are
// listed by label id rather than a `category:` search term (see
// CATEGORY_TO_GMAIL_QUERY below and syncCategoryPage) — Gmail excludes all
// three from ordinary listings, so they only arrive if asked for by name.
// STARRED is absent on purpose: starred mail already syncs inside its real
// category and is picked up by deriveFlags' isStarred.
export const ALL_CATEGORIES = [
  "PRIMARY", "PROMOTIONS", "SOCIAL", "UPDATES", "FORUMS", "SENT",
  "SPAM", "TRASH", "DRAFT",
];

/** Categories fetched by Gmail label id instead of a `category:` search term. */
export const CATEGORY_TO_GMAIL_LABEL: Record<string, string> = {
  SENT: "SENT",
  SPAM: "SPAM",
  TRASH: "TRASH",
  DRAFT: "DRAFT",
};

/**
 * Gmail uses CATEGORY_PERSONAL for the Primary tab, not CATEGORY_PRIMARY.
 * Map our internal category names → Gmail search query terms.
 *   Gmail search: `category:personal`, `category:social`, etc.
 * See: https://developers.google.com/gmail/api/guides/labels
 */
export const CATEGORY_TO_GMAIL_QUERY: Record<string, string> = {
  PRIMARY: "personal",
  SOCIAL: "social",
  PROMOTIONS: "promotions",
  UPDATES: "updates",
  FORUMS: "forums",
};

type PayloadHeader = { name?: string; value?: string };

export function extractHeader(msg: Record<string, unknown>, name: string): string {
  const payload = msg.payload as Record<string, unknown> | undefined;
  const headers = (payload?.headers ?? []) as PayloadHeader[];
  return headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  )?.value ?? "";
}

/** Categories that map to the PRIMARY tab (Primary + Updates merged). */
const PRIMARY_CATEGORIES = ["PRIMARY", "UPDATES"];

/**
 * Row filter for the PRIMARY tab.
 *
 * The `category` column is a LOSSY projection of Gmail's label *set*: a message
 * carries several labels at once and CATEGORY_PRECEDENCE (sync-metadata.ts)
 * collapses them to one enum. For almost every message that is harmless,
 * because the location labels it ranks highest — SENT/SPAM/TRASH/DRAFT — are
 * mutually exclusive with being in the inbox.
 *
 * A message you send to YOURSELF is the one case where that is false. Gmail
 * stores a single message resource labelled both `SENT` and `INBOX`, and shows
 * it in both places. Precedence resolves the tie to SENT — which is correct,
 * and must stay that way so the row still appears in the Sent view — so
 * filtering the inbox on the category column alone hid the message completely:
 * Gmail showed it in the Inbox, Mailroid showed it nowhere but Sent.
 *
 * `is_in_inbox` is the un-collapsed truth. deriveFlags reads the INBOX label
 * directly on every ingest path and always has, so this needs no backfill and
 * no resync — existing rows are already correct.
 *
 * Deliberately NOT fixed by reordering CATEGORY_PRECEDENCE to rank the tabs
 * above SENT: that would file the message as PRIMARY and drop it out of the
 * Sent view, trading one class of missing mail for another, and would break the
 * location-label semantics the Spam and Bin views depend on.
 */
function primaryViewFilter() {
  return or(
    inArray(messageMetadata.category, PRIMARY_CATEGORIES as any[]),
    and(
      eq(messageMetadata.category, "SENT" as any),
      eq(messageMetadata.isInInbox, true),
    ),
  );
}

/**
 * "STARRED" is a pseudo-category: a starred email still lives in its real
 * category (a starred promo is still PROMOTIONS), so the view filters on the
 * is_starred flag instead of the category column. Spam and Bin are excluded —
 * Gmail's own Starred view doesn't surface them either.
 */
const STARRED_VIEW = "STARRED";

/**
 * Row-level filter shared by every view: never show mail that Gmail has
 * permanently deleted. The row is deliberately retained (see is_archived on the
 * model) — this is what keeps it out of sight.
 */
function visibilityFilter(userId: string) {
  return and(
    eq(messageMetadata.userId, userId),
    eq(messageMetadata.isArchived, false),
  );
}

/**
 * Cheap per-user change token for the inbox. Returns the newest `updatedAt`
 * across the user's message metadata (in epoch ms), or 0 when the user has no
 * rows yet. `updatedAt` is bumped on every ingest and on async priority
 * reclassification, so an increasing value means "this user's mail changed" —
 * the client polls this and only re-fetches its cached lists when it grows.
 */
export async function getInboxVersion(userId: string): Promise<{ version: number }> {
  const rows = await db
    .select({ max: sql<string | null>`max(${messageMetadata.updatedAt})` })
    .from(messageMetadata)
    .where(eq(messageMetadata.userId, userId));

  const maxUpdatedAt = rows[0]?.max;
  const version = maxUpdatedAt ? new Date(maxUpdatedAt).getTime() : 0;
  return { version };
}

/**
 * Is there a message in this row's thread, for this user, matching `condition`
 * (written against alias `m2`)?
 *
 * The WHOLE thread, in every category — not just the messages that made it
 * into the current view. A Primary thread whose attachment travelled in the
 * user's own Sent reply still has an attachment, and its chips (which are
 * per thread, see enrichWithAttachments) already say so; a view-scoped answer
 * would disagree with them. Served by idx_mm_user_thread (user_id, thread_id).
 * A row with no thread_id is a thread of one, matched on its own entity_id.
 */
export function threadHasMessage(userId: string, threadId: SQLWrapper, entityId: SQLWrapper, condition: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${messageMetadata} AS m2
    WHERE m2.user_id = ${userId}
      AND (m2.thread_id = ${threadId} OR (${threadId} IS NULL AND m2.entity_id = ${entityId}))
      AND ${condition}
  )`;
}

/**
 * Thread-level has_attachment, tri-state like the column itself:
 *   true  — some message in the thread has a confirmed attachment
 *   null  — none confirmed, but some message has never been checked
 *   false — every message was checked, and none has one
 * Unknown is never folded into false: a "no" that nobody checked is a lie the
 * list would tell about the user's own mail.
 */
export function threadAttachmentState(userId: string, threadId: SQLWrapper, entityId: SQLWrapper): SQL<boolean | null> {
  return sql<boolean | null>`CASE
    WHEN ${threadHasMessage(userId, threadId, entityId, sql.raw("m2.has_attachment IS TRUE"))} THEN TRUE
    WHEN ${threadHasMessage(userId, threadId, entityId, sql.raw("m2.has_attachment IS NULL"))} THEN NULL
    ELSE FALSE
  END`;
}

export async function getEmailsByCategory(
  userId: string,
  category: string,
  opts?: {
    maxResults?: number;
    page?: number;
    /** Only threads with a CONFIRMED attachment. Unknown threads are excluded, not counted as "no". */
    withAttachments?: boolean;
  },
): Promise<{ threads: ThreadSummary[] }> {
  const limit = opts?.maxResults ?? 50;
  const page = opts?.page ?? 0;
  const offset = page * limit;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  logger.info("[SERVICE] getEmailsByCategory start", {
    requestId, userId, category, limit, page, offset,
  });

  // Starred filters on the flag across every real category, Primary needs the
  // is_in_inbox exception for self-sent mail (see primaryViewFilter), and every
  // other view filters on the category column itself.
  const viewFilter =
    category === STARRED_VIEW
      ? and(
          eq(messageMetadata.isStarred, true),
          notInArray(messageMetadata.category, ["TRASH", "SPAM", "DRAFT"] as any[]),
        )
      : category === "PRIMARY"
        ? primaryViewFilter()
        : eq(messageMetadata.category, category as any);

  // Browsing the inbox never triggers a sync — see docs/architecture-plan.md Stage 0.
  // The list is served straight from the local DB; missing history is only backfilled
  // by an explicit Gmail connect or a user-initiated resync.

  // ── Query the requested page from local DB ──────────────────────
  const sq = db
  .select({
    entityId: messageMetadata.entityId,
    threadId: messageMetadata.threadId,
    receivedAt: messageMetadata.receivedAt,
    sender: messageMetadata.sender,
    subject: messageMetadata.subject,
    snippet: messageMetadata.snippet,
    priority: messageMetadata.priority,
    priorityScore: messageMetadata.priorityScore,
    priorityReason: messageMetadata.priorityReason,
    isActionRequired: messageMetadata.isActionRequired,
    isReplyNeeded: messageMetadata.isReplyNeeded,
    isUnread: messageMetadata.isUnread,
    isStarred: messageMetadata.isStarred,
    isImportant: messageMetadata.isImportant,
    category: messageMetadata.category,
    draftId: messageMetadata.draftId,
    // Sent and Draft rows are all from the user, so "from" tells the reader
    // nothing — these views show who it went to instead.
    //
    // COALESCE, not one source: `message_metadata.recipient` is the real home
    // and every sync path now fills it, but rows imported before that column
    // existed are NULL. The `emails` row carries the same header and is already
    // present for anything hydrated, so it covers part of the backlog for free.
    // Rows with neither stay NULL and render as unknown rather than guessing.
    // `.as` is required, not cosmetic: a raw SQL field selected out of a
    // subquery has no name for the outer query to reference without it.
    recipient: sql<string | null>`COALESCE(${messageMetadata.recipient}, ${emails.to})`.as(
      "recipient",
    ),
    rn: sql<number>`
      ROW_NUMBER() OVER(
        PARTITION BY COALESCE(${messageMetadata.threadId}, ${messageMetadata.entityId})
        ORDER BY ${messageMetadata.receivedAt} DESC
      )
    `.as("rn"),
  })
  .from(messageMetadata)
  // LEFT, not inner: a metadata row whose emails row has not been hydrated yet
  // must still list. It simply has no recipient to show.
  .leftJoin(emails, eq(emails.gmailMessageId, messageMetadata.entityId))
  .where(and(visibilityFilter(userId), viewFilter))
  .as("sq");

  const rows = await db
  .select({
    entityId: sq.entityId,
    threadId: sq.threadId,
    receivedAt: sq.receivedAt,
    sender: sq.sender,
    subject: sq.subject,
    snippet: sq.snippet,
    priority: sq.priority,
    priorityScore: sq.priorityScore,
    priorityReason: sq.priorityReason,
    isActionRequired: sq.isActionRequired,
    isReplyNeeded: sq.isReplyNeeded,
    isUnread: sq.isUnread,
    isStarred: sq.isStarred,
    isImportant: sq.isImportant,
    category: sq.category,
    draftId: sq.draftId,
    recipient: sq.recipient,
    // The thread's answer, not the newest message's: the row stands for the
    // conversation, and its chips already cover every message in it.
    hasAttachment: threadAttachmentState(userId, sq.threadId, sq.entityId),
  })
  .from(sq)
  // rn = 1 picks the thread's newest message to stand for the row; the
  // attachment test looks at the whole thread, so an attachment on an older
  // message still matches and the row is still the newest message.
  .where(
    and(
      eq(sq.rn, 1),
      opts?.withAttachments
        ? threadHasMessage(userId, sq.threadId, sq.entityId, sql.raw("m2.has_attachment IS TRUE"))
        : undefined,
    ),
  )
  .orderBy(desc(sq.receivedAt))
  .offset(offset)
  .limit(limit);

  const validResults: ThreadSummary[] = rows.map((row) => ({
  threadId: row.threadId || row.entityId,
  sender: row.sender ?? "",
  subject: row.subject ?? "(no subject)",
  date: row.receivedAt?.toISOString() ?? "",
  snippet: row.snippet ?? "",
  // No MEDIUM fallback — a NULL priority means genuinely unclassified, and
  // the UI (PrioritySeal) renders an explicit "Unclassified" badge for that.
  priority: row.priority ?? undefined,
  priorityScore: row.priorityScore,
  priorityReason: row.priorityReason,
  isActionRequired: row.isActionRequired,
  isReplyNeeded: row.isReplyNeeded,
  isUnread: row.isUnread,
  isStarred: row.isStarred,
  isImportant: row.isImportant,
  category: row.category ?? undefined,
  recipient: row.recipient ?? undefined,
  // Carried so a Draft row can be reopened for editing without a second
  // round trip to resolve its Gmail draft id.
  draftId: row.draftId ?? undefined,
  entityId: row.entityId,
  hasAttachment: row.hasAttachment,
}));

await enrichWithAttachments(userId, validResults);

// One argument, not two. `logger.info("[SERVICE]", "msg", { … })` passes the
// message as splat, which winston's json format drops without splat() —
// producing a line reading exactly `{"level":"info","message":"[SERVICE]"}`
// with every field gone. Two of those are in the archived incident log.
logger.info("[SERVICE] getEmailsByCategory completed", {
  requestId,
  category,
  requestedRows: rows.length,
  validResults: validResults.length,
  rowsWithAttachments: validResults.filter((t) => t.attachments?.length).length,
});

return { threads: validResults };
}


export async function getCategoryCounts(
  userId: string,
): Promise<Record<string, number>> {
  const requestId = `${Date.now()}-cat`;

  logger.info("[SERVICE] getCategoryCounts start", {
    requestId,
    userId,
  });

  const counts: Record<string, number> = {
    PRIMARY: 0,
    PROMOTIONS: 0,
    SOCIAL: 0,
    FORUMS: 0,
    SENT: 0,
    SPAM: 0,
    TRASH: 0,
    DRAFT: 0,
    STARRED: 0,
  };

  const start = Date.now();

  const threadCount = sql<number>`
  count(
    distinct coalesce(
      ${messageMetadata.threadId},
      ${messageMetadata.entityId}
    )
  )
`;

  const rows = await db
    .select({
      category: messageMetadata.category,
      count: threadCount,
    })
    .from(messageMetadata)
    // Archived (Gmail-purged) rows are retained but must not inflate any
    // badge — the user can't see them in any view.
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.isArchived, false),
      ),
    )
    .groupBy(messageMetadata.category);

  for (const row of rows) {
    // PRIMARY — and the UPDATES it absorbs — is counted by its own query below.
    // Its view is no longer a plain category match (self-sent mail is filed
    // SENT but belongs in the inbox), and summing the two group-by buckets was
    // also wrong on its own terms: a thread holding both a PRIMARY and an
    // UPDATES message was counted twice by a list that shows it once.
    if (row.category === "PRIMARY" || row.category === "UPDATES") continue;
    if (
      row.category &&
      Object.prototype.hasOwnProperty.call(counts, row.category)
    ) {
      counts[row.category] = Number(row.count);
    }
  }

  // Must mirror getEmailsByCategory's viewFilter exactly, or the Primary badge
  // promises rows the list itself refuses to show.
  const primaryRows = await db
    .select({ count: threadCount })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.isArchived, false),
        primaryViewFilter(),
      ),
    );
  counts["PRIMARY"] = Number(primaryRows[0]?.count ?? 0);

  // Starred cuts across categories, so it needs its own query rather than a
  // group-by bucket. Same exclusions as the Starred view itself.
  const starredRows = await db
    .select({ count: threadCount })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.isArchived, false),
        eq(messageMetadata.isStarred, true),
        notInArray(messageMetadata.category, ["TRASH", "SPAM", "DRAFT"] as any[]),
      ),
    );
  counts["STARRED"] = Number(starredRows[0]?.count ?? 0);

  logger.info("[SERVICE] getCategoryCounts completed", {
    requestId,
    userId,
    counts,
    durationMs: Date.now() - start,
  });

  return counts;
}

export async function getPriorityEmails(
  userId: string,
  opts?: {
    priorities?: string[];
    days?: number;
    unreadOnly?: boolean;
    maxResults?: number;
    page?: number;
    /** Only threads with a CONFIRMED attachment. See getEmailsByCategory. */
    withAttachments?: boolean;
  }
): Promise<{ threads: ThreadSummary[] }> {
  const priorities = opts?.priorities ?? ["HIGH"];
  const days = opts?.days ?? 7;
  const unreadOnly = opts?.unreadOnly ?? false;
  const limit = opts?.maxResults ?? 50;
  const page = opts?.page ?? 0;
  const offset = page * limit;

  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - days);

  // "UNCLASSIFIED" isn't a real priority_level enum value — it means
  // priority IS NULL, so it needs its own clause rather than inArray.
  const wantsUnclassified = priorities.includes("UNCLASSIFIED");
  const realPriorities = priorities.filter((p) => p !== "UNCLASSIFIED");
  const priorityFilter = wantsUnclassified
    ? realPriorities.length > 0
      ? sql`(${inArray(messageMetadata.priority, realPriorities as any[])} OR ${messageMetadata.priority} IS NULL)`
      : sql`${messageMetadata.priority} IS NULL`
    : inArray(messageMetadata.priority, realPriorities as any[]);

  const filters = [
    eq(messageMetadata.userId, userId),
    priorityFilter,
    sql`${messageMetadata.receivedAt} >= ${thresholdDate}`,
    // Priority triage is about live mail: purged rows are invisible everywhere,
    // and spam/bin/drafts/sent would otherwise compete for the HIGH bucket.
    // Sent is excluded for the same reason searchLocalEmails excludes it
    // (see index.ts) — it's a copy of what the user themselves wrote, not
    // something they're triaging, and there's very little of it, so a sent
    // email happening to score HIGH would sit at the top of the list.
    eq(messageMetadata.isArchived, false),
    notInArray(messageMetadata.category, ["TRASH", "SPAM", "DRAFT", "SENT"] as any[]),
  ];

  if (unreadOnly) {
    filters.push(eq(messageMetadata.isUnread, true));
  }

  const sq = db
    .select({
      entityId: messageMetadata.entityId,
      threadId: messageMetadata.threadId,
      receivedAt: messageMetadata.receivedAt,
      sender: messageMetadata.sender,
      recipient: messageMetadata.recipient,
      subject: messageMetadata.subject,
      snippet: messageMetadata.snippet,
      priority: messageMetadata.priority,
      priorityScore: messageMetadata.priorityScore,
      priorityReason: messageMetadata.priorityReason,
      matchedSignals: messageMetadata.matchedSignals,
      isActionRequired: messageMetadata.isActionRequired,
      isReplyNeeded: messageMetadata.isReplyNeeded,
      isUnread: messageMetadata.isUnread,
      rn: sql<number>`
        ROW_NUMBER() OVER(
          PARTITION BY COALESCE(${messageMetadata.threadId}, ${messageMetadata.entityId})
          ORDER BY ${messageMetadata.receivedAt} DESC
        )
      `.as("rn"),
    })
    .from(messageMetadata)
    .where(and(...filters))
    .as("sq");

  const rows = await db
    .select({
      entityId: sq.entityId,
      threadId: sq.threadId,
      receivedAt: sq.receivedAt,
      sender: sq.sender,
      recipient: sq.recipient,
      subject: sq.subject,
      snippet: sq.snippet,
      priority: sq.priority,
      priorityScore: sq.priorityScore,
      priorityReason: sq.priorityReason,
      matchedSignals: sq.matchedSignals,
      isActionRequired: sq.isActionRequired,
      isReplyNeeded: sq.isReplyNeeded,
      isUnread: sq.isUnread,
      hasAttachment: threadAttachmentState(userId, sq.threadId, sq.entityId),
    })
    .from(sq)
    .where(
      and(
        eq(sq.rn, 1),
        opts?.withAttachments
          ? threadHasMessage(userId, sq.threadId, sq.entityId, sql.raw("m2.has_attachment IS TRUE"))
          : undefined,
      ),
    )
    .orderBy(
      desc(sq.isUnread),
      sql`${sq.priorityScore} DESC NULLS LAST`,
      desc(sq.receivedAt)
    )
    .offset(offset)
    .limit(limit);

  const threads: ThreadSummary[] = rows.map((row) => ({
    threadId: row.threadId || row.entityId,
    sender: row.sender ?? "",
    recipient: row.recipient ?? undefined,
    subject: row.subject ?? "(no subject)",
    date: row.receivedAt?.toISOString() ?? "",
    snippet: row.snippet ?? "",
    priority: row.priority ?? undefined,
    priorityScore: row.priorityScore,
    priorityReason: row.priorityReason,
    matchedSignals: row.matchedSignals,
    isActionRequired: row.isActionRequired,
    isReplyNeeded: row.isReplyNeeded,
    isUnread: row.isUnread,
    hasAttachment: row.hasAttachment,
  }));

  await enrichWithAttachments(userId, threads);

  return { threads };
}

export async function getPriorityCounts(
  userId: string,
  days: number = 7
): Promise<{ HIGH: number; MEDIUM: number; LOW: number; UNCLASSIFIED: number; ALL: number }> {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - days);

  const rows = await db
    .select({
      priority: messageMetadata.priority,
      count: sql<number>`count(distinct coalesce(${messageMetadata.threadId}, ${messageMetadata.entityId}))`,
    })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        sql`${messageMetadata.receivedAt} >= ${thresholdDate}`,
        // Must mirror getPriorityEmails' filters exactly, or the tab badges
        // promise rows the list itself refuses to show.
        eq(messageMetadata.isArchived, false),
        notInArray(messageMetadata.category, ["TRASH", "SPAM", "DRAFT", "SENT"] as any[]),
      )
    )
    .groupBy(messageMetadata.priority);

  // A NULL priority (genuinely unclassified — see message-metadata.ts) forms
  // its own group here with row.priority === null; without counting it, ALL
  // used to render "0 emails" on a full but not-yet-classified mailbox.
  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0, UNCLASSIFIED: 0, ALL: 0 };
  for (const row of rows) {
    if (row.priority === "HIGH") counts.HIGH = Number(row.count);
    else if (row.priority === "MEDIUM") counts.MEDIUM = Number(row.count);
    else if (row.priority === "LOW") counts.LOW = Number(row.count);
    else if (row.priority === null) counts.UNCLASSIFIED = Number(row.count);
  }
  counts.ALL = counts.HIGH + counts.MEDIUM + counts.LOW + counts.UNCLASSIFIED;
  return counts;
}