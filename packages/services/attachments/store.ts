import { db, and, eq, sql, inArray, notInArray, isNull, isNotNull, lt, desc } from "@repo/database";
import { messageAttachments } from "@repo/database/models/message-attachments";
import { messageMetadata } from "@repo/database/models/message-metadata";
import type { AttachmentMeta, AttachmentRecord, AttachmentStore } from "./types.ts";

/** Postgres rejects a malformed uuid with an error, not an empty result. Without
 *  this guard a junk id in the URL would 500 instead of 404 — which is both a
 *  worse experience and an oracle: an error means "not a uuid", silence means
 *  "not yours". */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = typeof messageAttachments.$inferSelect;

function toRecord(row: Row): AttachmentRecord {
  return {
    id: row.id,
    userId: row.userId,
    gmailMessageId: row.gmailMessageId,
    threadId: row.threadId,
    partId: row.partId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    gmailAttachmentId: row.gmailAttachmentId,
    isInline: row.isInline,
    contentId: row.contentId,
    cacheStorageKey: row.cacheStorageKey,
    cachedAt: row.cachedAt,
    lastAccessedAt: row.lastAccessedAt,
  };
}

export const dbAttachmentStore: AttachmentStore = {
  async findOwned(userId, attachmentId) {
    if (!UUID_RE.test(attachmentId)) return null;

    const [row] = await db
      .select()
      .from(messageAttachments)
      .where(
        // Ownership is part of the lookup, not a check performed on the result.
        // A row belonging to someone else is indistinguishable from one that
        // does not exist, which is what lets the caller answer 404 for both
        // without having to remember to.
        and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.userId, userId)),
      )
      .limit(1);

    return row ? toRecord(row) : null;
  },

  async touchAccessed(attachmentId, now) {
    // Throttled to roughly one write per day per attachment.
    //
    // Eviction measures 90 days, so day granularity is 90x finer than the
    // decision it feeds. Without the predicate every download becomes a DB
    // write, and a read path that writes on every request is exactly the
    // pattern reconciliation-cron.ts's header warns about.
    await db
      .update(messageAttachments)
      .set({ lastAccessedAt: now, updatedAt: now })
      .where(
        and(
          eq(messageAttachments.id, attachmentId),
          sql`(${messageAttachments.lastAccessedAt} IS NULL
                OR ${messageAttachments.lastAccessedAt} < ${now}::timestamptz - interval '1 day')`,
        ),
      );
  },

  async markCached(attachmentId, key, now) {
    // Unconditional and idempotent: the object key is derived from ids that
    // never change, so two concurrent writers necessarily agree on it. There is
    // no lost-update to guard against here — the race that matters is
    // write-vs-evict, and its guard lives on clearCached.
    await db
      .update(messageAttachments)
      .set({ cacheStorageKey: key, cachedAt: now, updatedAt: now })
      .where(eq(messageAttachments.id, attachmentId));
  },

  async clearCached(attachmentId, expectedCachedAt) {
    const cleared = await db
      .update(messageAttachments)
      .set({ cacheStorageKey: null, cachedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(messageAttachments.id, attachmentId),
          // Optimistic version check. Zero rows means a reader re-cached this
          // attachment between the sweep's SELECT and now, so the object it
          // points at is live and must not be unlinked.
          //
          // last_accessed_at is deliberately left alone: it is meaningful for
          // uncached rows too, and once the key is NULL this row can no longer
          // match the sweep, so skipping it stays idempotent.
          eq(messageAttachments.cachedAt, expectedCachedAt),
        ),
      )
      .returning({ id: messageAttachments.id });

    return cleared.length > 0;
  },

  async findEvictable(olderThan, limit) {
    const rows = await db
      .select()
      .from(messageAttachments)
      .where(
        sql`${messageAttachments.cacheStorageKey} IS NOT NULL
            AND COALESCE(${messageAttachments.lastAccessedAt}, ${messageAttachments.cachedAt}) < ${olderThan}::timestamptz`,
      )
      .orderBy(messageAttachments.cachedAt)
      .limit(limit);

    return rows.map(toRecord);
  },

  async refreshGmailAttachmentId(attachmentId, next) {
    await db
      .update(messageAttachments)
      .set({ gmailAttachmentId: next, updatedAt: new Date() })
      .where(eq(messageAttachments.id, attachmentId));
  },
};

/**
 * Replace a message's whole attachment manifest.
 *
 * Delete-then-insert rather than a diff: the payload we are handed is the
 * complete truth for that message, manifests are tiny, and a diff would have to
 * reason about parts that disappeared. Idempotent, so re-hydration and the
 * opportunistic write from a live thread read converge on the same rows.
 *
 * DELIBERATELY PRESERVES CACHE COLUMNS for parts that survive. Re-ingesting a
 * message must not invalidate a warm cache entry or, worse, orphan its stored
 * object by forgetting the key that points at it. This is why the upsert path
 * below carries the old cache values forward explicitly — a later "make the set
 * list complete" refactor would quietly break both.
 */
export async function replaceAttachmentManifest(
  userId: string,
  gmailMessageId: string,
  threadId: string | null,
  attachments: AttachmentMeta[],
): Promise<void> {
  // ONE TRANSACTION: the manifest rows and the "manifest done" stamp land
  // together or not at all, so the backfill can never see a stamped message
  // with a half-written manifest, or re-fetch one whose manifest is complete.
  await db.transaction(async (tx) => {
    await writeManifest(tx, userId, gmailMessageId, threadId, attachments);
    await tx
      .update(messageMetadata)
      .set({
        attachmentManifestAt: new Date(),
        attachmentManifestSkip: null,
        // The exact answer from the parsed parts supersedes the header-based
        // guess the metadata sync wrote (see the column's doc comment).
        hasAttachment: attachments.some((a) => !a.isInline),
      })
      .where(and(eq(messageMetadata.userId, userId), eq(messageMetadata.entityId, gmailMessageId)));
  });
}

type Executor = Pick<typeof db, "insert" | "delete">;

async function writeManifest(
  exec: Executor,
  userId: string,
  gmailMessageId: string,
  threadId: string | null,
  attachments: AttachmentMeta[],
): Promise<void> {
  if (attachments.length === 0) {
    await exec
      .delete(messageAttachments)
      .where(
        and(
          eq(messageAttachments.userId, userId),
          eq(messageAttachments.gmailMessageId, gmailMessageId),
        ),
      );
    return;
  }

  const now = new Date();

  await exec
    .insert(messageAttachments)
    .values(
      attachments.map((a) => ({
        userId,
        gmailMessageId,
        threadId,
        partId: a.partId,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        gmailAttachmentId: a.gmailAttachmentId,
        isInline: a.isInline,
        contentId: a.contentId,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [messageAttachments.gmailMessageId, messageAttachments.partId],
      // NOTE the omissions: cacheStorageKey, cachedAt and lastAccessedAt are
      // absent on purpose. See the doc comment above.
      set: {
        threadId: sql`excluded.thread_id`,
        filename: sql`excluded.filename`,
        mimeType: sql`excluded.mime_type`,
        sizeBytes: sql`excluded.size_bytes`,
        gmailAttachmentId: sql`excluded.gmail_attachment_id`,
        isInline: sql`excluded.is_inline`,
        contentId: sql`excluded.content_id`,
        updatedAt: now,
      },
    });

  // Parts that no longer exist in the message. Scoped to this message, so a
  // concurrent write for another message cannot be caught by it.
  const liveParts = attachments.map((a) => a.partId);
  await exec
    .delete(messageAttachments)
    .where(
      and(
        eq(messageAttachments.userId, userId),
        eq(messageAttachments.gmailMessageId, gmailMessageId),
        // notInArray, not a raw `NOT IN ${array}`: the template form binds the
        // whole array as a single parameter, which Postgres reads as one scalar
        // and which therefore matches nothing — the delete would silently
        // become a no-op and stale parts would accumulate forever.
        notInArray(messageAttachments.partId, liveParts),
      ),
    );
}

/**
 * Visible attachments for many threads at once, for the inbox list.
 *
 * One indexed query over the whole page of threads rather than one per row —
 * the list already costs a Gmail round trip per thread and does not need a
 * database round trip per row on top.
 *
 * Reads only what was already persisted. The list path fetches
 * `format:"metadata"` and never has a payload to parse, so a thread that has
 * never been hydrated contributes no rows and gets no chips. That is an absence
 * of information, not a claim of "no attachments" — the row says nothing either
 * way, and the thread view is where the distinction is stated honestly. Putting
 * an "unknown" marker on every un-hydrated row would be noise on the one screen
 * that has to stay scannable.
 */
export async function listAttachmentsForThreads(
  userId: string,
  threadIds: string[],
): Promise<Map<string, AttachmentRecord[]>> {
  const byThread = new Map<string, AttachmentRecord[]>();
  if (threadIds.length === 0) return byThread;

  const rows = await db
    .select()
    .from(messageAttachments)
    .where(
      and(
        eq(messageAttachments.userId, userId),
        inArray(messageAttachments.threadId, threadIds),
        // Body furniture never earns a chip in a list row.
        eq(messageAttachments.isInline, false),
      ),
    );

  for (const row of rows) {
    if (!row.threadId) continue;
    const list = byThread.get(row.threadId) ?? [];
    list.push(toRecord(row));
    byThread.set(row.threadId, list);
  }

  return byThread;
}

/**
 * One message's own manifest.
 *
 * Message-scoped rather than thread-scoped because forwarding carries the parts
 * of ONE message. Using listThreadAttachments here would attach every file
 * anyone had ever sent in the conversation to a forward of its third reply —
 * a data-disclosure bug, not merely a size one.
 */
export async function listMessageAttachments(
  userId: string,
  gmailMessageId: string,
): Promise<AttachmentRecord[]> {
  const rows = await db
    .select()
    .from(messageAttachments)
    .where(
      and(
        eq(messageAttachments.userId, userId),
        eq(messageAttachments.gmailMessageId, gmailMessageId),
      ),
    );

  return rows.map(toRecord);
}

/** The manifest for every message in a thread, for the thread view. */
export async function listThreadAttachments(
  userId: string,
  threadId: string,
): Promise<AttachmentRecord[]> {
  const rows = await db
    .select()
    .from(messageAttachments)
    .where(
      and(eq(messageAttachments.userId, userId), eq(messageAttachments.threadId, threadId)),
    );

  return rows.map(toRecord);
}

// ── Attachment-manifest backfill work list ───────────────────────────────
//
// Progress lives in message_metadata itself (attachment_manifest_at /
// _attempts / _skip), so the backfill is resumable and deduplicated by
// construction: the work list is a query, not a queue. Served by the partial
// index idx_mm_attachment_manifest_pending.

export const MANIFEST_MAX_ATTEMPTS = 3;

const pendingManifest = (userId: string) =>
  and(
    eq(messageMetadata.userId, userId),
    eq(messageMetadata.hasAttachment, true),
    isNull(messageMetadata.attachmentManifestAt),
    lt(messageMetadata.attachmentManifestAttempts, MANIFEST_MAX_ATTEMPTS),
    isNotNull(messageMetadata.threadId),
  );

/**
 * Threads needing a manifest, in the order the backfill should take them:
 * the given priority thread ids first (only those still pending), then the
 * rest newest-first, so the rows a user is looking at fill in first.
 */
export async function listManifestWork(
  userId: string,
  opts: { limit: number; priorityThreadIds?: string[] },
): Promise<string[]> {
  const out: string[] = [];
  const priority = [...new Set(opts.priorityThreadIds ?? [])].slice(0, opts.limit);

  if (priority.length > 0) {
    const rows = await db
      .selectDistinct({ threadId: messageMetadata.threadId })
      .from(messageMetadata)
      .where(and(pendingManifest(userId), inArray(messageMetadata.threadId, priority)));
    const pending = new Set(rows.map((r) => r.threadId));
    for (const id of priority) if (pending.has(id)) out.push(id);
  }

  if (out.length < opts.limit) {
    const rows = await db
      .select({ threadId: messageMetadata.threadId, newest: sql<Date>`max(${messageMetadata.receivedAt})` })
      .from(messageMetadata)
      .where(pendingManifest(userId))
      .groupBy(messageMetadata.threadId)
      .orderBy(desc(sql`max(${messageMetadata.receivedAt})`))
      .limit(opts.limit);
    for (const r of rows) {
      if (out.length >= opts.limit) break;
      if (r.threadId && !out.includes(r.threadId)) out.push(r.threadId);
    }
  }

  return out;
}

/**
 * A failed manifest fetch for a thread. Attempts are counted on every
 * still-unstamped message of the thread (the thread is the unit of work), so a
 * thread is tried at most MANIFEST_MAX_ATTEMPTS times. "too_deep" jumps
 * straight to the cap: re-fetching the same truncated structure cannot help,
 * and hydration or thread open (full reads, no depth limit) will complete it.
 */
export async function recordManifestFailure(
  userId: string,
  threadId: string,
  reason: "failed" | "too_deep",
): Promise<void> {
  await db
    .update(messageMetadata)
    .set({
      attachmentManifestAttempts:
        reason === "too_deep"
          ? MANIFEST_MAX_ATTEMPTS
          : sql`${messageMetadata.attachmentManifestAttempts} + 1`,
      attachmentManifestSkip: reason,
    })
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.threadId, threadId),
        isNull(messageMetadata.attachmentManifestAt),
      ),
    );
}

/** Mailboxes with pending manifest work, for the sweep. */
export async function usersWithManifestWork(limit = 200): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: messageMetadata.userId })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.hasAttachment, true),
        isNull(messageMetadata.attachmentManifestAt),
        lt(messageMetadata.attachmentManifestAttempts, MANIFEST_MAX_ATTEMPTS),
        isNotNull(messageMetadata.threadId),
      ),
    )
    .limit(limit);
  return rows.map((r) => r.userId);
}

/** Which of these threads have messages flagged as having attachments but no manifest yet. */
export async function threadsAwaitingManifest(userId: string, threadIds: string[]): Promise<string[]> {
  if (threadIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ threadId: messageMetadata.threadId })
    .from(messageMetadata)
    .where(and(pendingManifest(userId), inArray(messageMetadata.threadId, threadIds)));
  return rows.map((r) => r.threadId).filter((t): t is string => Boolean(t));
}

// ── Draft attachment housekeeping ─────────────────────────────────────────

/** How many attachment rows, other than `excludeId`, point at this stored object. */
export async function countKeyReferences(key: string, excludeId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(messageAttachments)
    .where(and(eq(messageAttachments.cacheStorageKey, key), sql`${messageAttachments.id} <> ${excludeId}`));
  return Number(row?.n ?? 0);
}

export async function deleteAttachmentRows(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(messageAttachments).where(inArray(messageAttachments.id, ids));
}

/**
 * Hand a row's stored object to the eviction sweep for deletion on its next
 * run, by backdating its access time. Used when deleting the object inline
 * failed: the sweep deletes the object and clears the pointer, and retries on
 * its own if it fails too — so a failed delete is never a silent orphan.
 */
export async function makeEvictionDue(id: string): Promise<void> {
  const epoch = new Date(0);
  await db
    .update(messageAttachments)
    .set({ lastAccessedAt: epoch, cachedAt: epoch })
    .where(and(eq(messageAttachments.id, id), isNotNull(messageAttachments.cacheStorageKey)));
}
