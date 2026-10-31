import { pgTable, text, timestamp, uuid, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Attachment manifest for a Gmail message. **Metadata only — never bytes.**
 *
 * Gmail is the durable store for attachment content. This table records what
 * attachments a message has, so the thread view can render chips and the bytes
 * route can authorise a request, without any sync path ever downloading a
 * file. A row is written from a payload we already hold (`ingestMessage` and
 * `getThread` both fetch `format:"full"`), so populating it costs no extra
 * Gmail call.
 *
 * A table rather than a jsonb column on `message_metadata`: attachment access
 * and lifecycle are a separate concern from message classification, and the
 * eviction sweep that arrives with the cache is an indexed range scan — clean
 * on a table, awkward inside jsonb.
 *
 * SOURCE-AGNOSTIC BY DESIGN. `gmail_message_id` is just a Gmail message id, and
 * sent mail already lives in `message_metadata` under the SENT category, so a
 * sent attachment is the same row shape as a received one. Downstream nothing
 * cares which it was: a `contract.pdf` you sent six months ago takes exactly
 * the path a received one takes.
 *
 * NO FOREIGN KEY TO `user`, matching `emails` / `message_metadata` /
 * `email_chunks` rather than the calendar tables. Mail data in this codebase is
 * keyed by a bare `user_id` and is not cascade-deleted; adding a cascade here
 * alone would make this table the odd one out and, once a cache exists, would
 * silently orphan stored objects on a delete nothing else in the mail path
 * performs.
 *
 * AN EMPTY MANIFEST IS NOT "NO ATTACHMENTS". Metadata-only synced mail
 * (`sync-metadata.ts` uses `threads.get(metadata)`) has no payload and
 * therefore no rows — a deliberate consequence of scoping hydration to the AI
 * window. Readers must distinguish:
 *
 *   live getThread (`full`)      → authoritative, parsed fresh
 *   hydrated message, rows exist → authoritative, from this manifest
 *   not hydrated, no rows        → UNKNOWN, and must render as unknown
 */
export const messageAttachments = pgTable(
  "message_attachments",
  {
    /**
     * Our own opaque id, and the only attachment identifier the browser ever
     * sees (`/api/attachments/{id}`).
     *
     * Deliberately not a composite of Gmail's ids: a server-owned uuid cannot
     * be hand-assembled to probe arbitrary Gmail objects, and ownership becomes
     * one indexed lookup rather than a trust decision about two
     * attacker-supplied strings.
     */
    id: uuid("id").primaryKey().defaultRandom(),

    userId: text("user_id").notNull(),

    /** Gmail message id — the `message_metadata.entity_id` this part belongs to. */
    gmailMessageId: text("gmail_message_id").notNull(),

    /** Carried so the thread view can fetch a whole thread's manifest in one query. */
    threadId: text("thread_id"),

    /**
     * Gmail's MIME part id (`payload.parts[].partId`). THE STABLE IDENTITY, and
     * the reason the unique index below is on (message, part) rather than on
     * the attachment id: `partId` describes a position in the message's MIME
     * tree, which does not change, and it is also what a `cid:` reference
     * resolves against.
     */
    partId: text("part_id").notNull(),

    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),

    /**
     * `body.size` as Gmail reported it.
     *
     * Load-bearing for more than display: the bytes route rejects an
     * oversized attachment from THIS column before it calls Gmail. Fetching
     * and then rejecting would mean the attacker still made us buy the memory,
     * which on a 1 GB box is the whole attack.
     */
    sizeBytes: integer("size_bytes").notNull(),

    /**
     * Gmail's `body.attachmentId`. A CACHE, NOT A KEY.
     *
     * It is an opaque per-fetch token with no documented durability guarantee,
     * and it demonstrably rotates. Storing it saves a round trip on the common
     * path; when it 404s, the fetcher re-reads the message, re-walks to
     * `part_id`, refreshes this column and retries once. That is why identity
     * lives on `part_id` and never on this.
     */
    gmailAttachmentId: text("gmail_attachment_id").notNull(),

    /**
     * True for parts referenced from the HTML body (a signature image, an
     * embedded screenshot) rather than offered as documents. The chip row
     * filters these out — showing a sender's logo as an attachment is noise —
     * but they stay in the table because `cid:` resolution needs them.
     */
    isInline: boolean("is_inline").notNull().default(false),

    /** `Content-ID` header, for resolving `cid:` refs in HTML bodies. */
    contentId: text("content_id"),

    // ── Cache metadata ────────────────────────────────────────────────
    //
    // METADATA FIELDS ONLY. Their presence does NOT mean caching is
    // implemented. Nothing in Stage 1 writes cacheStorageKey or cachedAt; they
    // exist now so enabling the object-storage cache is a config change rather
    // than a migration against a table that by then has production rows.
    //
    // There is deliberately NO `is_cached` boolean. Cache presence is *derived*
    // from `cache_storage_key IS NOT NULL`. A separate flag can drift out of
    // sync with the object that actually exists, and then the code trusts a lie.

    /** Object key in the cache, or NULL when not cached. Always NULL in Stage 1. */
    cacheStorageKey: text("cache_storage_key"),

    /** When the cached copy was written. Cleared, with the key, on eviction. */
    cachedAt: timestamp("cached_at", { withTimezone: true }),

    /**
     * Last successful user access — a cache HIT counts, not just a fetch from
     * Gmail. If only the miss path set this, a file opened every week would
     * never reset its clock (every one of those opens is a hit) and would be
     * evicted precisely for being popular. The clock tracks *access*.
     *
     * Survives eviction on purpose: it is meaningful for uncached rows too, and
     * once the key is NULL the row can no longer match the sweep.
     */
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * The conflict target for the re-ingest upsert. On (message, part) rather
     * than on `gmail_attachment_id`, which rotates and would mint duplicate
     * rows for one real attachment every time it did.
     */
    uniqueIndex("uq_message_attachments_msg_part").on(t.gmailMessageId, t.partId),
    index("idx_message_attachments_user_message").on(t.userId, t.gmailMessageId),
    index("idx_message_attachments_user_thread").on(t.userId, t.threadId),
    /**
     * Backs the eviction sweep. The generated SQL is hand-edited into a
     * partial index on COALESCE(last_accessed_at, cached_at) WHERE
     * cache_storage_key IS NOT NULL — drizzle-kit will not emit either the
     * expression or the predicate reliably, and the sweep only ever scans
     * cached rows, so the partial form keeps it tiny.
     */
    index("idx_message_attachments_evictable").on(t.cacheStorageKey, t.lastAccessedAt),
  ],
);

export type MessageAttachmentRow = typeof messageAttachments.$inferSelect;
export type NewMessageAttachmentRow = typeof messageAttachments.$inferInsert;
