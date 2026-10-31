import { logger } from "@repo/logger";

import { MAX_ATTACHMENT_BYTES } from "./admission.ts";
import { createInternalMissHandler, internalClientConfigFromEnv } from "./internal-client.ts";
import { dbAttachmentStore } from "./store.ts";
import { resolveStorage } from "./storage.ts";
import {
  AttachmentTooLargeError,
  StorageUnavailableError,
  type AttachmentMissHandler,
  type AttachmentPayload,
  type AttachmentReadDeps,
} from "./types.ts";

/**
 * THE READ SIDE OF ATTACHMENTS — safe to import from any process.
 *
 * Object storage is the only place attachment bytes are read from. This module
 * never talks to Gmail and must never import anything that does
 * (gmail-fetch.ts, ensure-stored.ts): the web process imports it, and a
 * source-scan test fails the build if either import appears here or in
 * apps/web. Populating storage on a miss is delegated to a per-process
 * handler (setAttachmentMissHandler):
 *
 *   API process  → ensureAttachmentStored, in-process
 *   web process  → the API's internal endpoint (internal-client.ts)
 */

export { extractAttachments, countVisibleAttachments, type ParsablePart } from "./parse.ts";
export {
  replaceAttachmentManifest,
  listThreadAttachments,
  listMessageAttachments,
  dbAttachmentStore,
} from "./store.ts";
export { disabledStorage, resolveStorage } from "./storage.ts";
export {
  admitUpload,
  MAX_ATTACHMENT_BYTES,
  __resetInflightBudget,
} from "./admission.ts";
export * from "./types.ts";

/**
 * WHERE THE HANDLER LIVES: on globalThis, under a registered symbol — not in a
 * module-level variable. Next.js bundles `instrumentation.ts` and each route
 * handler separately, and a workspace package like this one is compiled into
 * each bundle, so a module-level variable set at startup is invisible to the
 * copy a route handler runs. That shipped once: every miss in the web process
 * answered "no miss handler registered" (a safe 503, but nothing worked).
 */
const REGISTRY = Symbol.for("mailroid.attachments.missHandler");
type Registry = typeof globalThis & { [REGISTRY]?: AttachmentMissHandler | null };

/**
 * Register how this process populates storage on a confirmed miss: the API
 * server registers the in-process ensure; the web app's instrumentation hook
 * registers the internal-endpoint client.
 */
export function setAttachmentMissHandler(handler: AttachmentMissHandler | null): void {
  (globalThis as Registry)[REGISTRY] = handler;
}

let envHandler: AttachmentMissHandler | null | undefined;

/**
 * The registered handler, or — when nothing registered — the internal-endpoint
 * client built from API_INTERNAL_URL + INTERNAL_API_SECRET. That client only
 * asks the API to populate storage; it never talks to Gmail, so falling back to
 * it is safe in any process. With neither available a miss is a 503 — never a
 * Gmail call from the wrong process.
 */
function resolveMissHandler(): AttachmentMissHandler | null {
  const registered = (globalThis as Registry)[REGISTRY];
  if (registered) return registered;
  if (envHandler === undefined) {
    const config = internalClientConfigFromEnv();
    envHandler = config ? createInternalMissHandler(config) : null;
  }
  return envHandler;
}

/** Test seam — the env-derived handler is memoized per process. */
export function __resetMissHandler(): void {
  envHandler = undefined;
  (globalThis as Registry)[REGISTRY] = null;
}

async function readObject(
  storage: AttachmentReadDeps["storage"],
  key: string,
  ids: { userId: string; attachmentId: string },
) {
  try {
    return await storage.getObject(key);
  } catch (err) {
    // An outage is not a miss. Treating it as one would turn a storage incident
    // into a Gmail download for every attachment anyone opens.
    logger.error("[ATTACHMENTS] storage read failed (treated as unavailable, not a miss)", {
      ...ids, error: String(err),
    });
    throw new StorageUnavailableError("error");
  }
}

/**
 * Stream one attachment for a user, from object storage.
 *
 * Returns null when the attachment does not exist OR is not theirs — the caller
 * cannot tell which and must answer 404 for both (a 403 would confirm the id
 * exists).
 *
 * ORDER IS THE SECURITY PROPERTY: ownership first, then the size gate, then
 * storage. Exactly three outcomes from storage:
 *   hit    → stream it.
 *   miss   → confirmed absent (no pointer, or the store answered not-found):
 *            the miss handler populates storage (the API is the only Gmail
 *            reader), then this reads the object back from storage.
 *   error  → StorageUnavailableError (503). Never a Gmail call.
 */
export async function getAttachmentBytes(
  userId: string,
  attachmentId: string,
  deps: Partial<AttachmentReadDeps> = {},
): Promise<AttachmentPayload | null> {
  const store = deps.store ?? dbAttachmentStore;
  const storage = deps.storage ?? resolveStorage();
  const onMiss = deps.onMiss ?? resolveMissHandler();
  const now = deps.now ?? (() => new Date());
  const ids = { userId, attachmentId };

  const record = await store.findOwned(userId, attachmentId);
  if (!record) {
    logger.info("[ATTACHMENTS] not found or not owned", ids);
    return null;
  }

  if (record.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(record.sizeBytes, MAX_ATTACHMENT_BYTES);
  }

  if (!storage.enabled) throw new StorageUnavailableError("not_configured");

  if (record.cacheStorageKey) {
    const hit = await readObject(storage, record.cacheStorageKey, ids);
    if (hit) {
      await store.touchAccessed(record.id, now()).catch((err: unknown) => {
        // Bookkeeping for eviction; never worth failing a download over.
        logger.warn("[ATTACHMENTS] touchAccessed failed", { attachmentId, error: String(err) });
      });
      return { record, body: hit.stream, contentLength: hit.contentLength, populated: false };
    }
    logger.warn("[ATTACHMENTS] pointer with no object behind it; treating as a confirmed miss", ids);
  }

  if (!onMiss) {
    logger.error("[ATTACHMENTS] confirmed miss but no miss handler registered in this process", ids);
    throw new StorageUnavailableError("not_configured");
  }

  const outcome = await onMiss(userId, attachmentId);
  if (outcome.status === "not_found") return null;

  const stored = await readObject(storage, outcome.key, ids);
  if (!stored) {
    // The populator just confirmed the object. Absent now means storage is
    // misbehaving; looping back to the populator would hide that.
    logger.error("[ATTACHMENTS] object missing immediately after it was stored", { ...ids, key: outcome.key });
    throw new StorageUnavailableError("error");
  }
  return { record, body: stored.stream, contentLength: stored.contentLength, populated: true };
}
