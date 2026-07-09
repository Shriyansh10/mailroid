import { corsair } from "@repo/corsair";
import { db, eq, and, sql, desc, inArray } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";
import type { ThreadSummary } from "./model.ts";
import { processMessages, mapWithConcurrency } from "./sync-metadata.ts";
import { withGmailRetry } from "./retry.ts";

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

/**
 * Map our internal category names → Gmail CATEGORY_* label IDs for
 * counting via messages.list.  SENT uses labelIds directly.
 */
const CATEGORY_TO_GMAIL_LABEL: Record<string, string> = {
  PRIMARY: "CATEGORY_PERSONAL",
  SOCIAL: "CATEGORY_SOCIAL",
  PROMOTIONS: "CATEGORY_PROMOTIONS",
  UPDATES: "CATEGORY_UPDATES",
  FORUMS: "CATEGORY_FORUMS",
  SENT: "SENT",
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

export async function getEmailsByCategory(
  userId: string,
  category: string,
  opts?: { maxResults?: number; page?: number },
): Promise<{ threads: ThreadSummary[] }> {
    console.log("📨 GET EMAILS", category, "page=", opts?.page ?? 0);
  const limit = opts?.maxResults ?? 50;
  const page = opts?.page ?? 0;
  const offset = page * limit;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  logger.info("[SERVICE] getEmailsByCategory start", {
    requestId, userId, category, limit, page, offset,
  });

  const categories = resolveCategories(category);

  // ── 1. Count how many we have locally ──────────────────────────────
  const dbStart = Date.now();
  let countResult = await db
    .select({ count: sql<number>`count(DISTINCT COALESCE(${messageMetadata.threadId}, ${messageMetadata.entityId}))` })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        inArray(messageMetadata.category, categories as any[]),
      ),
    );
  const totalCount = Number(countResult[0]?.count ?? 0);
  const needed = offset + limit;

  logger.info("[DB] getEmailsByCategory count query", {
    requestId, category, categories, totalCount, needed, durationMs: Date.now() - dbStart,
  });

  // ── 2. Backfill from Gmail if local DB doesn't have enough ─────────
  if (totalCount < needed) {
    logger.info("[SERVICE] getEmailsByCategory backfill needed", {
      requestId, category, categories, totalCount, needed, deficit: needed - totalCount,
    });
    const tenant = corsair.withTenant(userId);

    // When PRIMARY is requested, backfill both `category:personal` and `category:updates`
    const gmailQueries = categories
      .filter((c) => c !== "SENT")
      .map((c) => CATEGORY_TO_GMAIL_QUERY[c])
      .filter(Boolean);
    const isSent = category === "SENT";

    let pageToken: string | undefined;
    const targetNew = needed - totalCount + 10;

    for (
      let newMessages = 0;
      newMessages < targetNew;
    ) {
      const batchSize = Math.min(100, targetNew - newMessages + 10);
      const gmailStart = Date.now();

      // Build Gmail query — for PRIMARY we combine both categories
      const q = isSent
        ? undefined
        : gmailQueries.map((t) => `category:${t}`).join(" OR ");

      logger.info("[GMAIL] threads.list call (backfill)", {
        requestId, category, q: q ?? "(labelIds)", batchSize, pageToken: pageToken ?? null,
      });
      const listResult = await withGmailRetry<{
        threads?: Array<{ id?: string }>;
        nextPageToken?: string | null;
      }>(`threads.list backfill ${category}`, () =>
        tenant.gmail.api.threads.list({
          maxResults: batchSize,
          ...(isSent
            ? { labelIds: ["SENT"] }
            : q
              ? { q }
              : { labelIds: ["INBOX"] }),
          pageToken: pageToken ?? undefined,
        }),
      );

      const threadStubs = (listResult.threads ?? []) as Array<{ id?: string }>;

      if (!threadStubs || threadStubs.length === 0) break;

      // Fetch metadata for each thread to extract message IDs — concurrency-
      // limited + retried so a transient 429 skips one thread instead of
      // aborting the whole backfill page.
      const detailed = await mapWithConcurrency(
        threadStubs,
        10,
        (t: { id?: string }) =>
          withGmailRetry(`threads.get backfill ${t.id}`, () =>
            (tenant.gmail.api as any).threads.get({
              id: t.id!,
              format: "metadata",
            }),
          ),
      );

      const messageIds = detailed
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
        .flatMap((t: Record<string, unknown>) => {
          const msgs = (t.messages ?? []) as Array<{ id?: string }>;
          return msgs.map((m) => m.id).filter(Boolean) as string[];
        });


const before = await db
  .select({ count: sql<number>`count(*)` })
  .from(messageMetadata)
  .where(eq(messageMetadata.userId, userId));

console.log("BEFORE", before[0]?.count);

await processMessages(userId, messageIds);

const after = await db
  .select({ count: sql<number>`count(*)` })
  .from(messageMetadata)
  .where(eq(messageMetadata.userId, userId));

console.log("AFTER", after[0]?.count);

newMessages += messageIds.length;

      if (!listResult.nextPageToken) break;
      pageToken = listResult.nextPageToken as string;
    }

    // Re-count after backfill
    const recountStart = Date.now();
    countResult = await db
      .select({ count: sql<number>`count(DISTINCT COALESCE(${messageMetadata.threadId}, ${messageMetadata.entityId}))` })
      .from(messageMetadata)
      .where(
        and(
          eq(messageMetadata.userId, userId),
          inArray(messageMetadata.category, categories as any[]),
        ),
      );
    const newCount = Number(countResult[0]?.count ?? 0);
  }

  // ── 3. Query the requested page from local DB ──────────────────────
  const dbQueryStart = Date.now();
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

  console.log("🤦DB PAGE QUERY DONE", Date.now());

  const validResults: ThreadSummary[] = rows.map((row) => ({
  threadId: row.threadId || row.entityId,
  sender: row.sender ?? "",
  subject: row.subject ?? "(no subject)",
  date: row.receivedAt?.toISOString() ?? "",
  snippet: row.snippet ?? "",
  priority: row.priority ?? "MEDIUM",
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

  const filters = [
    eq(messageMetadata.userId, userId),
    inArray(messageMetadata.priority, priorities as any[]),
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
    priority: row.priority ?? "MEDIUM",
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
): Promise<{ HIGH: number; MEDIUM: number; LOW: number; ALL: number }> {
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

  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0, ALL: 0 };
  for (const row of rows) {
    if (row.priority === "HIGH") counts.HIGH = Number(row.count);
    else if (row.priority === "MEDIUM") counts.MEDIUM = Number(row.count);
    else if (row.priority === "LOW") counts.LOW = Number(row.count);
  }
  counts.ALL = counts.HIGH + counts.MEDIUM + counts.LOW;
  return counts;
}