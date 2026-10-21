import { logger } from "@repo/logger";

import { extractAttachments, type ParsablePart } from "../attachments/parse.ts";
import {
  countKeyReferences,
  deleteAttachmentRows,
  dbAttachmentStore,
  listMessageAttachments,
  makeEvictionDue,
  replaceAttachmentManifest,
} from "../attachments/store.ts";
import { cacheKeyForRecord } from "../attachments/keys.ts";
import { resolveStorage } from "../attachments/storage.ts";
import { fetchDraftStructure } from "../attachments/structure.ts";
import type { AttachmentRecord, ObjectStorage } from "../attachments/types.ts";

/**
 * DRAFT ATTACHMENTS SURVIVE SAVES.
 *
 * Every draft save makes Gmail mint a NEW message id, and attachment records
 * are keyed on (message id, part id) — so each save produced fresh, uncached
 * records, every later edit re-downloaded every kept file from Gmail, and the
 * replaced records' stored objects were left with nothing pointing at them
 * (the record-driven eviction sweep can never find those).
 *
 * The identity of a draft file is its STORED OBJECT. After each save this:
 *
 *   1. reads the new draft's part STRUCTURE (no content) and writes its records;
 *   2. matches new records to the files we just sent, by position, confirmed by
 *      filename and size — any doubt and nothing is carried (that file falls
 *      back to one fetch later; never a guess);
 *   3. kept file   → the new record points at the existing object (no upload,
 *                    no Gmail download);
 *      new upload  → the bytes already in hand are written, the stored size is
 *                    verified, and only THEN is the record marked stored;
 *   4. removed / no-longer-referenced objects are deleted only when no other
 *      record points at them; a failed delete keeps its record and hands it to
 *      the eviction sweep, which retries.
 *
 * NEVER FAILS THE SAVE. The Gmail draft is the real copy. Anything this cannot
 * do leaves records UNMARKED (a later read fetches from Gmail once) and is
 * logged in full — Mailroid never believes a file is stored when it is not.
 */

export interface OutgoingDraftFile {
  filename: string;
  content: Buffer;
  /** The stored object this file was read from, when it was a kept attachment. */
  storedKey: string | null;
}

export interface SettleDeps {
  fetchDraftStructure: typeof fetchDraftStructure;
  replaceAttachmentManifest: typeof replaceAttachmentManifest;
  listMessageAttachments: typeof listMessageAttachments;
  markCached: (id: string, key: string, now: Date) => Promise<void>;
  countKeyReferences: typeof countKeyReferences;
  deleteAttachmentRows: typeof deleteAttachmentRows;
  makeEvictionDue: typeof makeEvictionDue;
  storage: ObjectStorage;
  now: () => Date;
}

function defaultDeps(): SettleDeps {
  return {
    fetchDraftStructure,
    replaceAttachmentManifest,
    listMessageAttachments,
    markCached: (id, key, now) => dbAttachmentStore.markCached(id, key, now),
    countKeyReferences,
    deleteAttachmentRows,
    makeEvictionDue,
    storage: resolveStorage(),
    now: () => new Date(),
  };
}

export interface SettleResult {
  carried: number;
  stored: number;
  unmatched: boolean;
  storeFailures: number;
  removedObjects: number;
  deleteFailures: number;
}

/**
 * Settle a draft's attachment records after a save.
 *
 * @param previousRows the records of the draft's PREVIOUS message (before this
 *   save), read after its kept files were fetched, so their pointers are current.
 * @param outgoing the files sent in this save, in the order they were put in the
 *   message (kept files first, then new uploads).
 */
export async function settleDraftAttachments(
  userId: string,
  draftId: string,
  previousRows: AttachmentRecord[],
  outgoing: OutgoingDraftFile[],
  deps: Partial<SettleDeps> = {},
): Promise<SettleResult> {
  const d = { ...defaultDeps(), ...deps };
  const result: SettleResult = { carried: 0, stored: 0, unmatched: false, storeFailures: 0, removedObjects: 0, deleteFailures: 0 };
  const keysStillUsed = new Set<string>();

  // 1. The new message's structure → its records.
  let newRows: AttachmentRecord[] = [];
  try {
    const message = await d.fetchDraftStructure(userId, draftId, { ctx: { trigger: "ui", operation: "drafts.get", targetId: draftId } });
    if (message?.id) {
      const parts = extractAttachments(message.payload as ParsablePart | undefined);
      await d.replaceAttachmentManifest(userId, message.id, message.threadId ?? null, parts);
      const rows = await d.listMessageAttachments(userId, message.id);
      // Message order, attachments only (inline parts are body furniture).
      const order = new Map(parts.map((p, i) => [p.partId, i]));
      newRows = rows.filter((r) => !r.isInline).sort((a, b) => (order.get(a.partId) ?? 0) - (order.get(b.partId) ?? 0));
    }
  } catch (err) {
    logger.error("[ATTACHMENTS] draft settle: could not read the saved draft's structure; nothing carried", {
      userId, draftId, error: String((err as Error)?.message ?? err),
    });
  }

  // 2. Match by position, confirmed by name and size. Any doubt → carry nothing.
  const matches =
    newRows.length === outgoing.length &&
    newRows.every((row, i) => row.filename === outgoing[i]!.filename && row.sizeBytes === outgoing[i]!.content.byteLength);
  if (newRows.length > 0 && !matches) {
    result.unmatched = true;
    logger.warn("[ATTACHMENTS] draft settle: saved parts do not line up with what was sent; nothing carried", {
      userId, draftId, saved: newRows.length, sent: outgoing.length,
    });
  }

  // 3. Carry kept objects; store new uploads (write → verify → mark).
  if (matches && d.storage.enabled) {
    for (let i = 0; i < newRows.length; i++) {
      const row = newRows[i]!;
      const file = outgoing[i]!;
      if (file.storedKey) {
        await d.markCached(row.id, file.storedKey, d.now());
        keysStillUsed.add(file.storedKey);
        result.carried++;
        continue;
      }
      const key = cacheKeyForRecord(row, d.storage.keyPrefix);
      try {
        await d.storage.putObject(key, file.content, { contentType: row.mimeType });
        const head = await d.storage.headObject(key);
        if (!head || head.contentLength !== file.content.byteLength) {
          throw new Error(`verification failed: expected ${file.content.byteLength} bytes, found ${head?.contentLength ?? "none"}`);
        }
        await d.markCached(row.id, key, d.now());
        keysStillUsed.add(key);
        result.stored++;
      } catch (err) {
        // Recoverable: the record stays unmarked, so a later read fetches it
        // from the Gmail draft once. Never marked stored on a failed write.
        result.storeFailures++;
        logger.error("[ATTACHMENTS] draft settle: could not store an uploaded draft file; it will be fetched from Gmail when next needed", {
          userId, draftId, attachmentId: row.id, error: String((err as Error)?.message ?? err),
        });
      }
    }
  }

  // 4. The previous message's records are gone from Gmail. Their objects are
  //    deleted unless still used (carried) or referenced by any other record.
  const deletable: string[] = [];
  for (const old of previousRows) {
    const key = old.cacheStorageKey;
    if (!key || keysStillUsed.has(key)) {
      deletable.push(old.id);
      continue;
    }
    try {
      if ((await d.countKeyReferences(key, old.id)) > 0) {
        deletable.push(old.id); // someone else still points at it: keep the object
        continue;
      }
      await d.storage.deleteObject(key);
      result.removedObjects++;
      deletable.push(old.id);
    } catch (err) {
      // Keep the record and hand it to the eviction sweep, which deletes the
      // object and retries on its own failures. Observable, never silent.
      result.deleteFailures++;
      logger.error("[ATTACHMENTS] draft settle: could not delete a removed draft file's object; queued for the eviction sweep", {
        userId, draftId, attachmentId: old.id, error: String((err as Error)?.message ?? err),
      });
      await d.makeEvictionDue(old.id).catch((e: unknown) => {
        logger.error("[ATTACHMENTS] draft settle: could not queue the object for eviction", {
          userId, attachmentId: old.id, error: String(e),
        });
      });
    }
  }
  await d.deleteAttachmentRows(deletable).catch((err: unknown) => {
    logger.error("[ATTACHMENTS] draft settle: could not delete the replaced draft's records", {
      userId, draftId, error: String(err),
    });
  });

  logger.info("[ATTACHMENTS] draft attachments settled", { userId, draftId, ...result });
  return result;
}
