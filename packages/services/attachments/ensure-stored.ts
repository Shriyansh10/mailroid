import { logger } from "@repo/logger";

import { admitDownload, MAX_ATTACHMENT_BYTES } from "./admission.ts";
import { cacheKeyForRecord } from "./keys.ts";
import { fetchAttachmentFromGmail } from "./gmail-fetch.ts";
import { coalesce } from "./single-flight.ts";
import { dbAttachmentStore } from "./store.ts";
import { resolveStorage } from "./storage.ts";
import {
  AttachmentTooLargeError,
  StorageUnavailableError,
  type AttachmentRecord,
  type AttachmentStore,
  type ObjectStorage,
} from "./types.ts";

/** See keys.ts — kept under this name for the API-side callers and tests. */
export const cacheKeyFor = cacheKeyForRecord;

export interface EnsureDeps {
  store: Pick<AttachmentStore, "findOwned" | "markCached" | "touchAccessed">;
  storage: ObjectStorage;
  fetchFromGmail: (tenantId: string, record: AttachmentRecord) => Promise<Buffer>;
  now: () => Date;
}

export type EnsureOutcome =
  /** The object is in storage at `key`; read it from there. */
  | { status: "stored"; key: string; record: AttachmentRecord; fetchedFromGmail: boolean }
  /** No such attachment for this user (or not theirs — indistinguishable on purpose). */
  | { status: "not_found" };

/**
 * Make sure one attachment's bytes are in object storage. API PROCESS ONLY.
 *
 * This is the single place a Gmail attachment download is allowed to start.
 * Object storage is the read source for everything else; this function's job is
 * to populate it, once, under the shared mailbox controls.
 *
 *   ownership   findOwned(userId, id) — 404 for absent AND not-yours, so the
 *               caller cannot be used as an existence oracle. The internal
 *               endpoint's secret authenticates the calling service; this check
 *               is the user-level authorization, and it is never skipped.
 *   size gate   before any network call.
 *   storage     head the object. Present → done, no Gmail. A storage ERROR
 *               (anything but a confirmed not-found) is thrown as
 *               StorageUnavailableError: an outage is never treated as a miss,
 *               or a storage incident would turn into a Gmail download storm.
 *   miss        single-flight on the storage key, then byte-budget admission,
 *               then fetchAttachmentFromGmail (gates, pacing, semaphore, ledger
 *               with bytes, 5-attempt cap), then:
 *   write       putObject → headObject verifies the stored size → markCached.
 *               The row is marked only after the object is confirmed present
 *               at the expected size, so a pointer never names a missing or
 *               truncated object.
 */
export async function ensureAttachmentStored(
  userId: string,
  attachmentId: string,
  deps: Partial<EnsureDeps> = {},
): Promise<EnsureOutcome> {
  const store = deps.store ?? dbAttachmentStore;
  const storage = deps.storage ?? resolveStorage();
  const fetchFromGmail = deps.fetchFromGmail ?? ((t: string, r: AttachmentRecord) => fetchAttachmentFromGmail(t, r));
  const now = deps.now ?? (() => new Date());

  const record = await store.findOwned(userId, attachmentId);
  if (!record) return { status: "not_found" };

  if (record.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(record.sizeBytes, MAX_ATTACHMENT_BYTES);
  }

  if (!storage.enabled) {
    throw new StorageUnavailableError("not_configured");
  }

  const key = record.cacheStorageKey ?? cacheKeyFor(record, storage.keyPrefix);

  return coalesce(`ensure:${key}`, async (): Promise<EnsureOutcome> => {
    // Someone may have stored it since the caller looked (or the row predates
    // its pointer). Confirm before touching Gmail.
    let present: { contentLength: number } | null;
    try {
      present = await storage.headObject(key);
    } catch (err) {
      logger.error("[ATTACHMENTS] storage head failed; refusing to fall back to Gmail", {
        userId, attachmentId, error: String(err),
      });
      throw new StorageUnavailableError("error");
    }
    if (present) {
      if (!record.cacheStorageKey) await store.markCached(record.id, key, now());
      return { status: "stored", key, record, fetchedFromGmail: false };
    }

    const release = admitDownload(userId, record.sizeBytes);
    try {
      const bytes = await fetchFromGmail(userId, record);

      try {
        await storage.putObject(key, bytes, { contentType: record.mimeType });
        const written = await storage.headObject(key);
        if (!written || written.contentLength !== bytes.byteLength) {
          throw new Error(
            `stored object verification failed: expected ${bytes.byteLength} bytes, found ${written?.contentLength ?? "none"}`,
          );
        }
      } catch (err) {
        // The Gmail download succeeded but storage did not take it. Not marked
        // cached, and not served from memory either: storage is the read
        // source, so the caller gets a retryable "unavailable".
        logger.error("[ATTACHMENTS] storage write failed after Gmail fetch", {
          userId, attachmentId, error: String(err),
        });
        throw new StorageUnavailableError("error");
      }

      await store.markCached(record.id, key, now());
      await store.touchAccessed(record.id, now()).catch(() => {});
      logger.info("[ATTACHMENTS] stored after first access", {
        userId, attachmentId, sizeBytes: bytes.byteLength,
      });
      return { status: "stored", key, record, fetchedFromGmail: true };
    } finally {
      release();
    }
  });
}
