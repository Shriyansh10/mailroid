/**
 * Tests for ensureAttachmentStored — the ONE place a Gmail attachment download
 * may start (API process only).
 *
 * Guards:
 *   - storage is checked first; an object already there costs no Gmail call;
 *   - a storage ERROR is never treated as a miss (no Gmail on outage);
 *   - write → verify → mark: the row is marked only after the object is
 *     confirmed present at the expected size;
 *   - concurrent misses for one attachment cause exactly one Gmail download;
 *   - a crash between "stored" and "marked" reconciles without re-downloading.
 *
 * No DB, no network: object-literal collaborators with counters.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ensureAttachmentStored, cacheKeyFor } from "./ensure-stored.ts";
import { MAX_ATTACHMENT_BYTES, __resetInflightBudget } from "./admission.ts";
import { __resetAttachmentSingleFlight } from "./single-flight.ts";
import { disabledStorage } from "./storage.ts";
import {
  AttachmentTooLargeError,
  StorageUnavailableError,
  type AttachmentRecord,
  type ObjectStorage,
} from "./types.ts";

const USER = "user-a";
const ID = "22222222-2222-4222-8222-222222222222";

function record(over: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: ID, userId: USER, gmailMessageId: "msg-1", threadId: "t-1", partId: "1",
    filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1024, gmailAttachmentId: "g-1",
    isInline: false, contentId: null, cacheStorageKey: null, cachedAt: null, lastAccessedAt: null,
    ...over,
  };
}

function fakeStore(row: AttachmentRecord | null, opts: { failMark?: number } = {}) {
  const calls = { findOwned: 0, marked: [] as string[], touched: 0 };
  let markFailures = opts.failMark ?? 0;
  return {
    calls,
    store: {
      async findOwned() {
        calls.findOwned++;
        return row;
      },
      async markCached(_id: string, key: string) {
        if (markFailures > 0) {
          markFailures--;
          throw new Error("db write failed");
        }
        calls.marked.push(key);
      },
      async touchAccessed() {
        calls.touched++;
      },
    },
  };
}

interface StorageOpts {
  headFails?: boolean;
  putFails?: boolean;
  /** Report a different size on head after a put (truncated write). */
  truncate?: boolean;
}

function memoryStorage(initial: Record<string, Buffer> = {}, opts: StorageOpts = {}) {
  const map = new Map(Object.entries(initial));
  const calls = { head: 0, put: [] as string[] };
  const storage: ObjectStorage = {
    enabled: true,
    keyPrefix: "dev",
    async getObject() {
      return null;
    },
    async putObject(key, body) {
      calls.put.push(key);
      if (opts.putFails) throw new Error("PUT 500");
      map.set(key, body);
    },
    async deleteObject(key) {
      map.delete(key);
    },
    async headObject(key) {
      calls.head++;
      if (opts.headFails) throw Object.assign(new Error("timeout"), { $metadata: { httpStatusCode: 503 } });
      const v = map.get(key);
      if (!v) return null;
      return { contentLength: opts.truncate ? v.length - 1 : v.length };
    },
  };
  return { storage, map, calls };
}

function gmailSpy(bytes = Buffer.from("file-bytes"), delayMs = 0) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetch: async () => {
      calls++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return bytes;
    },
  };
}

function reset() {
  __resetAttachmentSingleFlight();
  __resetInflightBudget();
}

test("a confirmed miss downloads from Gmail once, writes, verifies, THEN marks", async () => {
  reset();
  const s = fakeStore(record());
  const mem = memoryStorage();
  const gmail = gmailSpy();

  const out = await ensureAttachmentStored(USER, ID, { store: s.store, storage: mem.storage, fetchFromGmail: gmail.fetch });

  assert.equal(out.status, "stored");
  const key = cacheKeyFor(record(), "dev");
  assert.equal(out.status === "stored" && out.key, key);
  assert.equal(gmail.calls, 1);
  assert.deepEqual(mem.calls.put, [key]);
  assert.equal(mem.map.get(key)?.toString(), "file-bytes");
  assert.deepEqual(s.calls.marked, [key], "marked only after the verified write");
});

test("an object already in storage costs no Gmail call (and backfills a missing pointer)", async () => {
  reset();
  const key = cacheKeyFor(record(), "dev");
  const s = fakeStore(record());
  const mem = memoryStorage({ [key]: Buffer.from("already") });
  const gmail = gmailSpy();

  const out = await ensureAttachmentStored(USER, ID, { store: s.store, storage: mem.storage, fetchFromGmail: gmail.fetch });

  assert.equal(out.status, "stored");
  assert.equal(gmail.calls, 0);
  assert.deepEqual(s.calls.marked, [key]);
});

test("a storage OUTAGE on the existence check never falls back to Gmail", async () => {
  reset();
  const s = fakeStore(record());
  const mem = memoryStorage({}, { headFails: true });
  const gmail = gmailSpy();

  await assert.rejects(
    () => ensureAttachmentStored(USER, ID, { store: s.store, storage: mem.storage, fetchFromGmail: gmail.fetch }),
    StorageUnavailableError,
  );
  assert.equal(gmail.calls, 0);
});

test("a failed write is never marked cached and answers unavailable", async () => {
  reset();
  const s = fakeStore(record());
  const mem = memoryStorage({}, { putFails: true });
  const gmail = gmailSpy();

  await assert.rejects(
    () => ensureAttachmentStored(USER, ID, { store: s.store, storage: mem.storage, fetchFromGmail: gmail.fetch }),
    StorageUnavailableError,
  );
  assert.deepEqual(s.calls.marked, [], "no pointer to an object that was never written");
});

test("a size mismatch on verification is never marked cached", async () => {
  reset();
  const s = fakeStore(record());
  const mem = memoryStorage({}, { truncate: true });
  const gmail = gmailSpy();

  await assert.rejects(
    () => ensureAttachmentStored(USER, ID, { store: s.store, storage: mem.storage, fetchFromGmail: gmail.fetch }),
    StorageUnavailableError,
  );
  assert.deepEqual(s.calls.marked, []);
});

test("10 concurrent misses for one attachment cause exactly one Gmail download", async () => {
  reset();
  const s = fakeStore(record());
  const mem = memoryStorage();
  const gmail = gmailSpy(Buffer.from("x"), 20);

  const outs = await Promise.all(
    Array.from({ length: 10 }, () =>
      ensureAttachmentStored(USER, ID, { store: s.store, storage: mem.storage, fetchFromGmail: gmail.fetch }),
    ),
  );

  assert.equal(gmail.calls, 1);
  assert.ok(outs.every((o) => o.status === "stored"));
  assert.equal(mem.calls.put.length, 1);
});

test("stored-but-not-marked (crash between) reconciles on the next request without re-downloading", async () => {
  reset();
  const s = fakeStore(record(), { failMark: 1 });
  const mem = memoryStorage();
  const gmail = gmailSpy();

  await assert.rejects(() =>
    ensureAttachmentStored(USER, ID, { store: s.store, storage: mem.storage, fetchFromGmail: gmail.fetch }),
  );
  assert.equal(gmail.calls, 1);

  const out = await ensureAttachmentStored(USER, ID, { store: s.store, storage: mem.storage, fetchFromGmail: gmail.fetch });
  assert.equal(out.status, "stored");
  assert.equal(gmail.calls, 1, "the object was already there; Gmail is not asked again");
  assert.equal(s.calls.marked.length, 1);
});

test("an attachment that is not the user's is not_found, and nothing is touched", async () => {
  reset();
  const s = fakeStore(null);
  const mem = memoryStorage();
  const gmail = gmailSpy();

  const out = await ensureAttachmentStored("user-b", ID, { store: s.store, storage: mem.storage, fetchFromGmail: gmail.fetch });
  assert.equal(out.status, "not_found");
  assert.equal(mem.calls.head, 0);
  assert.equal(gmail.calls, 0);
});

test("oversized and unconfigured are refused before any network call", async () => {
  reset();
  const gmail = gmailSpy();
  await assert.rejects(
    () =>
      ensureAttachmentStored(USER, ID, {
        store: fakeStore(record({ sizeBytes: MAX_ATTACHMENT_BYTES + 1 })).store,
        storage: memoryStorage().storage,
        fetchFromGmail: gmail.fetch,
      }),
    AttachmentTooLargeError,
  );
  await assert.rejects(
    () => ensureAttachmentStored(USER, ID, { store: fakeStore(record()).store, storage: disabledStorage, fetchFromGmail: gmail.fetch }),
    (err: unknown) => err instanceof StorageUnavailableError && err.reason === "not_configured",
  );
  assert.equal(gmail.calls, 0);
});

test("the write key is always environment-prefixed, and a stored pointer is honoured", async () => {
  reset();
  const prodMem = memoryStorage();
  (prodMem.storage as { keyPrefix: string }).keyPrefix = "prod";
  await ensureAttachmentStored(USER, ID, { store: fakeStore(record()).store, storage: prodMem.storage, fetchFromGmail: gmailSpy().fetch });
  assert.ok(prodMem.calls.put[0]!.startsWith("prod/attachments/"), `got ${prodMem.calls.put[0]}`);

  reset();
  const legacy = "attachments/user-a/legacy";
  const mem = memoryStorage({ [legacy]: Buffer.from("x") });
  const gmail = gmailSpy();
  const out = await ensureAttachmentStored(USER, ID, {
    store: fakeStore(record({ cacheStorageKey: legacy })).store,
    storage: mem.storage,
    fetchFromGmail: gmail.fetch,
  });
  assert.equal(out.status === "stored" && out.key, legacy);
  assert.equal(gmail.calls, 0);
});
