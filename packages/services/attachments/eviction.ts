/**
 * Cache eviction — the sweep that keeps the object store from growing forever.
 *
 * WHAT THIS DELETES: Mailroid's cached copy, and only that. Gmail still holds
 * the attachment, so an evicted row is not a lost file — the next request for it
 * misses, fetches from Gmail, and re-caches transparently. That is the whole
 * ownership contract in one function: the cache is a disposable optimisation,
 * never a dependency, and eviction is the proof that we actually believe it.
 *
 * ACCEPTED LEAK, DOCUMENTED RATHER THAN FIXED: this sweep can only find objects
 * that a `message_attachments` row still points at. If a row is ever deleted —
 * by a future account-deletion flow, or by hand — its object becomes unreachable
 * and this sweep will never see it again. No such deletion path exists in the
 * repo today. The `attachments/{userId}/` key prefix is the mitigation kept for
 * whenever a purge does get built: it makes a per-account purge a prefix delete
 * rather than a table scan.
 */
import { logger } from "@repo/logger";

import { dbAttachmentStore } from "./store.ts";
import { resolveStorage } from "./storage.ts";
import type { AttachmentStore, ObjectStorage } from "./types.ts";

/** 90 days without an access. Deliberately generous: re-caching costs one Gmail
 *  fetch, so evicting too eagerly is cheap but pointless churn. */
export const EVICTION_AGE_DAYS = 90;

/** One batch. The sweep is daily and idempotent, so a backlog drains over
 *  consecutive runs rather than needing one heroic pass. */
export const EVICTION_BATCH_LIMIT = 500;

export interface EvictionResult {
  scanned: number;
  deleted: number;
  /** Rows a reader re-cached between the SELECT and the clear. See below. */
  skippedRecached: number;
  /** Rows whose object delete failed; left intact for the next run. */
  failed: number;
}

export interface EvictionDeps {
  store: AttachmentStore;
  storage: ObjectStorage;
  now(): Date;
  ageDays: number;
  limit: number;
}

/**
 * Delete cached objects that have not been read in `ageDays`.
 *
 * ORDER: object first, pointer second. This is the safe direction, and the
 * unsafe one is genuinely tempting, so it is worth stating why. Clearing the
 * pointer first and then failing the delete strands the object permanently —
 * nothing references it any more, so no future sweep can ever find it. Deleting
 * first and then failing the clear leaves a pointer to a missing object, which
 * the read path already treats as a miss and heals on the next access.
 * Recoverable beats unrecoverable.
 */
export async function evictExpiredAttachments(
  deps: Partial<EvictionDeps> = {},
): Promise<EvictionResult> {
  const store = deps.store ?? dbAttachmentStore;
  const storage = deps.storage ?? resolveStorage();
  const now = deps.now ?? (() => new Date());
  const ageDays = deps.ageDays ?? EVICTION_AGE_DAYS;
  const limit = deps.limit ?? EVICTION_BATCH_LIMIT;

  const empty: EvictionResult = { scanned: 0, deleted: 0, skippedRecached: 0, failed: 0 };

  // TOTAL NO-OP WHEN THE CACHE IS OFF, AND IT MUST BE CHECKED HERE RATHER THAN
  // PER ROW. `disabledStorage.deleteObject` throws by design — it is an
  // assertion that some caller skipped the `enabled` guard. A deployment that
  // once had the cache on and now has it off still has non-null
  // `cache_storage_key` rows in the table, so without this line the sweep would
  // select them and throw on every single one.
  if (!storage.enabled) return empty;

  const olderThan = new Date(now().getTime() - ageDays * 24 * 60 * 60 * 1000);
  const rows = await store.findEvictable(olderThan, limit);

  const result: EvictionResult = { ...empty, scanned: rows.length };

  for (const row of rows) {
    // The query guarantees both, but the types do not, and a narrowing here is
    // cheaper than a nullable key reaching the SDK.
    if (!row.cacheStorageKey || !row.cachedAt) continue;

    try {
      await storage.deleteObject(row.cacheStorageKey);
    } catch (err) {
      // Left entirely intact — key, timestamp, everything. The row simply
      // re-matches tomorrow. A transient storage error must not cost us the
      // pointer, because losing the pointer is what orphans the object.
      result.failed++;
      logger.error("[ATTACHMENTS] eviction: object delete failed, row left for next run", {
        attachmentId: row.id,
        key: row.cacheStorageKey,
        error: String(err),
      });
      continue;
    }

    // THE C5 GUARD. Conditional on `cachedAt` being unchanged since the SELECT.
    const cleared = await store.clearCached(row.id, row.cachedAt);

    if (cleared) {
      result.deleted++;
      continue;
    }

    // Zero rows updated means a reader re-cached this attachment between our
    // SELECT and now — and because the object key is deterministic, it re-cached
    // to the very key we just deleted. So the pointer is live and points at
    // nothing.
    //
    // This is the residual the delete-first ordering buys, and it is the correct
    // trade: the read path treats a missing object as a miss, serves from Gmail
    // and re-caches, so the cost is one extra Gmail fetch for one user. What we
    // must NOT do is clear the pointer anyway — that is precisely the C5 bug,
    // and it would strand the object the reader just wrote.
    //
    // Logged at warn rather than merely counted: a nonzero value here means a
    // live object was deleted, which is worth seeing even though it self-heals.
    result.skippedRecached++;
    logger.warn("[ATTACHMENTS] eviction: row re-cached mid-sweep, pointer left alone", {
      attachmentId: row.id,
      note: "object was deleted; next read will miss, re-fetch from Gmail and re-cache",
    });
  }

  logger.info("[ATTACHMENTS] eviction sweep complete", { ...result, ageDays, limit });
  return result;
}
