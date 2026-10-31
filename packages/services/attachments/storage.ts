import { resolveAttachmentCacheConfig } from "./config.ts";
import { s3Storage } from "./s3-storage.ts";
import type { ObjectStorage } from "./types.ts";

/**
 * THE STAGE SEAM.
 *
 * `resolveStorage()` is the entire boundary between "attachments come from
 * Gmail" and "attachments come from a cache in front of Gmail". Stage 2 changed
 * this one function and nothing in `getAttachmentBytes` or the route handler —
 * the two places where a mistake is a security bug rather than a performance
 * one. Shipping the full hit / miss / stale-pointer / write logic in Stage 1
 * against an always-disabled storage is what bought that.
 *
 * WHEN THE CACHE IS OFF: no client is constructed, no credential is read, no
 * socket is opened. What is NOT true — and an earlier version of this comment
 * claimed it was — is that the SDK goes unloaded. `s3-storage.ts` is a static
 * import, so `@aws-sdk/client-s3` is resident in every process that touches
 * attachments, cache on or off, at a few MB on a container capped at 512m.
 *
 * That is deliberate. The alternative is a dynamic import, which would make
 * this function async — and it is called per-request from `getAttachmentBytes`,
 * so awaiting it means editing the one file Stage 2 exists to leave alone. A few
 * MB of resident module is the cheaper side of that trade, and the disabled
 * state is a development and pre-flag condition rather than the steady state.
 */

/**
 * The "no cache configured" storage.
 *
 * `getObject` reports absence rather than throwing, so the read path treats a
 * disabled cache identically to a cold one and needs no special case.
 *
 * The writes throw on purpose. They are assertions, not behaviour: every call
 * site checks `storage.enabled` first, so if one of these ever fires it means a
 * code path forgot the guard. Failing loudly beats silently attempting a
 * network call against a deployment that was never configured for one.
 */
export const disabledStorage: ObjectStorage = {
  enabled: false,
  // Never used: every write path is guarded by `enabled` and the two writers
  // below throw. An empty string rather than a plausible-looking default, so a
  // key built from this storage could never silently look legitimate.
  keyPrefix: "",
  async getObject() {
    return null;
  },
  async putObject() {
    throw new Error(
      "[ATTACHMENTS] putObject called while the cache is disabled — a caller skipped the storage.enabled guard.",
    );
  },
  async deleteObject() {
    throw new Error(
      "[ATTACHMENTS] deleteObject called while the cache is disabled — a caller skipped the storage.enabled guard.",
    );
  },
  async headObject() {
    return null;
  },
};

/**
 * Resolve the object storage for this process.
 *
 * MEMOIZED, AND THAT IS LOAD-BEARING. `getAttachmentBytes` calls this on EVERY
 * request (`deps.storage ?? resolveStorage()`), which was free while the answer
 * was a frozen constant. An S3Client is not free: it owns a connection pool and
 * an HTTPS agent, so building one per request would open a fresh socket for
 * every attachment and leave the pool doing nothing. The client is constructed
 * once, on first use, and reused for the process lifetime.
 *
 * Still lazy rather than module-scope, for the same reason the config resolver
 * is: nothing may read credentials or construct a client at import time, or
 * `next build` breaks on a machine that has no production secrets.
 *
 * When the cache is off this returns `disabledStorage` and no client is ever
 * constructed — the disabled path costs nothing and touches no network.
 */
let memo: ObjectStorage | undefined;

export function resolveStorage(): ObjectStorage {
  if (memo === undefined) {
    const config = resolveAttachmentCacheConfig();
    memo = config ? s3Storage(config) : disabledStorage;
  }
  return memo;
}

/** Test seam — the memoized client would otherwise leak between cases. */
export function __resetStorage(): void {
  memo = undefined;
}
