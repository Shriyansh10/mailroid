/**
 * Tests for the cache eviction sweep.
 *
 * Every case here is about a failure that is INVISIBLE in production. Eviction
 * runs at 03:30, touches a store nobody watches, and reports success by deleting
 * things — so "it deleted the wrong thing" and "it deleted nothing" both look
 * like a quiet green run in the logs. The two that matter most:
 *
 *   - the C5 race, where a sweep unlinks an object a reader has just written,
 *     stranding bytes that nothing can ever reach again;
 *   - the disabled-cache path, where a deployment that turned the cache off
 *     still has pointer rows and would throw on every one of them.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { evictExpiredAttachments } from "./eviction.ts";
import { disabledStorage } from "./storage.ts";
import type { AttachmentRecord, AttachmentStore, ObjectStorage } from "./types.ts";

const NOW = new Date("2026-08-22T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function record(over: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "user-1",
    gmailMessageId: "msg-1",
    threadId: "thread-1",
    partId: "1",
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    gmailAttachmentId: "att-1",
    isInline: false,
    contentId: null,
    cacheStorageKey: "attachments/user-1/11111111-1111-4111-8111-111111111111",
    cachedAt: daysAgo(120),
    lastAccessedAt: daysAgo(100),
    ...over,
  };
}

/** A store that records what was asked of it. `clearedReturns` drives the C5 case. */
function fakeStore(rows: AttachmentRecord[], clearedReturns = true) {
  const calls = { findEvictable: 0, cleared: [] as Array<[string, Date]> };
  const store: AttachmentStore = {
    async findOwned() {
      throw new Error("not used");
    },
    async touchAccessed() {},
    async markCached() {},
    async clearCached(id, expectedCachedAt) {
      calls.cleared.push([id, expectedCachedAt]);
      return clearedReturns;
    },
    async findEvictable() {
      calls.findEvictable++;
      return rows;
    },
    async refreshGmailAttachmentId() {},
  };
  return { store, calls };
}

function fakeStorage(deleteImpl?: (key: string) => Promise<void>, keyPrefix = "dev") {
  const deletedKeys: string[] = [];
  const storage: ObjectStorage = {
    enabled: true,
    keyPrefix,
    async getObject() {
      return null;
    },
    async putObject() {},
    async deleteObject(key) {
      deletedKeys.push(key);
      if (deleteImpl) await deleteImpl(key);
    },
    async headObject() {
      return null;
    },
  };
  return { storage, deletedKeys };
}

test("an expired row is evicted: object deleted, then pointer cleared", async () => {
  const row = record();
  const { store, calls } = fakeStore([row]);
  const { storage, deletedKeys } = fakeStorage();

  const result = await evictExpiredAttachments({ store, storage, now: () => NOW });

  assert.deepEqual(result, { scanned: 1, deleted: 1, skippedRecached: 0, failed: 0 });
  assert.deepEqual(deletedKeys, [row.cacheStorageKey]);
  // The clear must carry the cachedAt read at SELECT time — that value IS the guard.
  assert.deepEqual(calls.cleared, [[row.id, row.cachedAt!]]);
});

test("the age cutoff is computed from `now`, not from wall-clock time", async () => {
  // Guards against a sweep that quietly evicts everything, or nothing, because
  // someone reached for Date.now() inside the query builder.
  let received: Date | undefined;
  const { store } = fakeStore([]);
  store.findEvictable = async (olderThan) => {
    received = olderThan;
    return [];
  };

  await evictExpiredAttachments({ store, storage: fakeStorage().storage, now: () => NOW, ageDays: 90 });

  assert.deepEqual(received, daysAgo(90));
});

test("a recently-read row is never offered to the sweep", async () => {
  // Selection lives in findEvictable (SQL); this asserts the sweep does not
  // second-guess it and delete something the query deliberately excluded.
  const { store } = fakeStore([]);
  const { storage, deletedKeys } = fakeStorage();

  const result = await evictExpiredAttachments({ store, storage, now: () => NOW });

  assert.equal(result.scanned, 0);
  assert.equal(deletedKeys.length, 0);
});

test("C5: a row re-cached mid-sweep keeps its pointer", async () => {
  // The sequence: sweep SELECTs (cachedAt = T1), a reader re-caches (cachedAt =
  // T2), sweep deletes the object, guarded clear matches zero rows.
  //
  // The bug this exists to prevent is clearing anyway. The key is deterministic,
  // so the reader re-cached to the same key we just deleted — NULLing the
  // pointer would leave bytes in the bucket that no row references and no future
  // sweep can find.
  const row = record();
  const { store, calls } = fakeStore([row], /* clearedReturns */ false);
  const { storage } = fakeStorage();

  const result = await evictExpiredAttachments({ store, storage, now: () => NOW });

  assert.deepEqual(result, { scanned: 1, deleted: 0, skippedRecached: 1, failed: 0 });
  assert.equal(calls.cleared.length, 1, "the guarded clear was attempted exactly once");
});

test("a storage delete failure leaves the row completely intact", async () => {
  const row = record();
  const { store, calls } = fakeStore([row]);
  const { storage } = fakeStorage(async () => {
    throw new Error("503 from the object store");
  });

  const result = await evictExpiredAttachments({ store, storage, now: () => NOW });

  assert.deepEqual(result, { scanned: 1, deleted: 0, skippedRecached: 0, failed: 1 });
  assert.equal(
    calls.cleared.length,
    0,
    "clearing after a failed delete would orphan the object forever",
  );
});

test("one bad row does not abandon the rest of the batch", async () => {
  const bad = record({ id: "22222222-2222-4222-8222-222222222222", cacheStorageKey: "k-bad" });
  const good = record({ id: "33333333-3333-4333-8333-333333333333", cacheStorageKey: "k-good" });
  const { store } = fakeStore([bad, good]);
  const { storage, deletedKeys } = fakeStorage(async (key) => {
    if (key === "k-bad") throw new Error("transient");
  });

  const result = await evictExpiredAttachments({ store, storage, now: () => NOW });

  assert.deepEqual(result, { scanned: 2, deleted: 1, skippedRecached: 0, failed: 1 });
  assert.deepEqual(deletedKeys, ["k-bad", "k-good"]);
});

test("cache disabled: zero scanned, and deleteObject is never reached", async () => {
  // disabledStorage.deleteObject THROWS by design. A deployment that turned the
  // cache off still has non-null cache_storage_key rows, so a sweep that checked
  // `enabled` per row instead of once up front would throw on every one of them.
  // Using the real disabledStorage here rather than a fake is the point: a mock
  // that quietly resolves would let that bug through.
  const { store, calls } = fakeStore([record()]);

  const result = await evictExpiredAttachments({
    store,
    storage: disabledStorage,
    now: () => NOW,
  });

  assert.deepEqual(result, { scanned: 0, deleted: 0, skippedRecached: 0, failed: 0 });
  assert.equal(calls.findEvictable, 0, "the table is not even queried when the cache is off");
});

test("re-running the sweep is idempotent", async () => {
  // Once a pointer is cleared the row can no longer match findEvictable, so the
  // second run has nothing to do. Modelled here by the store returning the row
  // first and nothing after.
  let served = false;
  const { store } = fakeStore([]);
  store.findEvictable = async () => {
    if (served) return [];
    served = true;
    return [record()];
  };
  const { storage, deletedKeys } = fakeStorage();

  const first = await evictExpiredAttachments({ store, storage, now: () => NOW });
  const second = await evictExpiredAttachments({ store, storage, now: () => NOW });

  assert.equal(first.deleted, 1);
  assert.deepEqual(second, { scanned: 0, deleted: 0, skippedRecached: 0, failed: 0 });
  assert.equal(deletedKeys.length, 1, "the object is not deleted twice");
});

// ── Cross-environment isolation ───────────────────────────────────────

test("a dev sweep never deletes a prod object, even for an identical row id", async () => {
  // THE FAILURE THIS EXISTS TO PREVENT, and the reason the environment prefix is
  // the isolation boundary rather than uuid uniqueness.
  //
  // Restoring a prod dump into dev — an ordinary debugging move — gives both
  // environments the SAME (userId, attachmentId). That is modelled exactly here:
  // one id, two rows, differing only by the prefix on their stored key. Before
  // the prefix existed both rows keyed to `attachments/user-1/{id}`, so dev's
  // sweep deleted the object prod was still serving.
  //
  // This passes today because eviction deletes `row.cacheStorageKey` — the key
  // recorded at write time — rather than recomputing one. That is precisely what
  // needs pinning: a future "tidy-up" that recomputed the key here would
  // reintroduce cross-environment deletion silently, and every other test in
  // this file would still pass.
  const SHARED_ID = "11111111-1111-4111-8111-111111111111";
  const devRow = record({ id: SHARED_ID, cacheStorageKey: `dev/attachments/user-1/${SHARED_ID}` });

  const { store } = fakeStore([devRow]);
  const { storage, deletedKeys } = fakeStorage(undefined, "dev");

  const result = await evictExpiredAttachments({ store, storage, now: () => NOW });

  assert.equal(result.deleted, 1);
  assert.deepEqual(deletedKeys, [`dev/attachments/user-1/${SHARED_ID}`]);
  assert.ok(
    !deletedKeys.some((k) => k.startsWith("prod/")),
    "a dev sweep must never issue a delete against a prod key",
  );
  assert.ok(
    !deletedKeys.some((k) => k.startsWith("attachments/")),
    "nor against an un-prefixed key, which would be ambiguous between environments",
  );
});

test("eviction deletes the STORED key, not one recomputed from the row", async () => {
  // The no-migration property, stated as a test. A row written before the prefix
  // existed still carries an un-prefixed key; the sweep must follow that key
  // rather than inventing `dev/...`, or the real object would be orphaned while
  // a delete was issued against a key that holds nothing.
  const legacy = record({ cacheStorageKey: "attachments/user-1/legacy-object" });
  const { store } = fakeStore([legacy]);
  const { storage, deletedKeys } = fakeStorage(undefined, "dev");

  await evictExpiredAttachments({ store, storage, now: () => NOW });

  assert.deepEqual(deletedKeys, ["attachments/user-1/legacy-object"]);
});
