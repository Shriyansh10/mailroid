import { db, eq, and, sql, desc, inArray } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";
import type { ThreadSummary } from "./model.ts";

export const ALL_CATEGORIES = [
  "PRIMARY", "PROMOTIONS", "SOCIAL", "UPDATES", "FORUMS", "SENT",
];

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
 * Resolve the category filter. When "PRIMARY" is requested, include UPDATES too.
 */
function resolveCategories(category: string): string[] {
  if (category === "PRIMARY") return PRIMARY_CATEGORIES;
  return [category];
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

export async function getEmailsByCategory(
  userId: string,
  category: string,
  opts?: { maxResults?: number; page?: number },
): Promise<{ threads: ThreadSummary[] }> {
  const limit = opts?.maxResults ?? 50;
  const page = opts?.page ?? 0;
  const offset = page * limit;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  logger.info("[SERVICE] getEmailsByCategory start", {
    requestId, userId, category, limit, page, offset,
  });

  const categories = resolveCategories(category);

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
    rn: sql<number>`
      ROW_NUMBER() OVER(
        PARTITION BY COALESCE(${messageMetadata.threadId}, ${messageMetadata.entityId})
        ORDER BY ${messageMetadata.receivedAt} DESC
      )
    `.as("rn"),
  })
  .from(messageMetadata)
  .where(
    and(
      eq(messageMetadata.userId, userId),
      inArray(messageMetadata.category, categories as any[]),
    ),
  )
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
  })
  .from(sq)
  .where(eq(sq.rn, 1))
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
}));

logger.info("[SERVICE]", "getEmailsByCategory completed", {
  requestId,
  category,
  requestedRows: rows.length,
  validResults: validResults.length,
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
  };

  const start = Date.now();

  const rows = await db
    .select({
      category: messageMetadata.category,
      count: sql<number>`
  count(
    distinct coalesce(
      ${messageMetadata.threadId},
      ${messageMetadata.entityId}
    )
  )
`,
    })
    .from(messageMetadata)
    .where(eq(messageMetadata.userId, userId))
    .groupBy(messageMetadata.category);

  for (const row of rows) {
    if (row.category === "UPDATES") {
      // Merge UPDATES count into PRIMARY
      counts["PRIMARY"] = (counts["PRIMARY"] ?? 0) + Number(row.count);
    } else if (
      row.category &&
      Object.prototype.hasOwnProperty.call(counts, row.category)
    ) {
      counts[row.category] = Number(row.count);
    }
  }

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
      subject: messageMetadata.subject,
      snippet: messageMetadata.snippet,
      priority: messageMetadata.priority,
      priorityScore: messageMetadata.priorityScore,
      priorityReason: messageMetadata.priorityReason,
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
      subject: sq.subject,
      snippet: sq.snippet,
      priority: sq.priority,
      priorityScore: sq.priorityScore,
      priorityReason: sq.priorityReason,
      isActionRequired: sq.isActionRequired,
      isReplyNeeded: sq.isReplyNeeded,
      isUnread: sq.isUnread,
    })
    .from(sq)
    .where(eq(sq.rn, 1))
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
    subject: row.subject ?? "(no subject)",
    date: row.receivedAt?.toISOString() ?? "",
    snippet: row.snippet ?? "",
    priority: row.priority ?? undefined,
    priorityScore: row.priorityScore,
    priorityReason: row.priorityReason,
    isActionRequired: row.isActionRequired,
    isReplyNeeded: row.isReplyNeeded,
    isUnread: row.isUnread,
  }));

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
        sql`${messageMetadata.receivedAt} >= ${thresholdDate}`
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