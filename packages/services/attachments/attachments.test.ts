/**
 * Tests for the attachment READ path (index.ts) and the MIME parser.
 *
 * The property this file guards: **object storage is the only read source, and
 * only a CONFIRMED miss may lead to a Gmail download.** A storage outage is an
 * outage (503), never a miss — otherwise a storage incident turns into a Gmail
 * download for every attachment anyone opens.
 *
 * The read path never talks to Gmail itself. On a confirmed miss it calls the
 * process's miss handler (the API populates storage), then reads the object
 * back from storage. These cases drive that handler as a spy.
 *
 * No DB, no network, no SDK. Every collaborator is an object literal.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { getAttachmentBytes, setAttachmentMissHandler, __resetMissHandler } from "./index.ts";
import { cacheKeyFor } from "./ensure-stored.ts";
import { MAX_ATTACHMENT_BYTES } from "./admission.ts";
import { __resetAttachmentSingleFlight, coalesce } from "./single-flight.ts";
import { disabledStorage } from "./storage.ts";
import { extractAttachments, countVisibleAttachments } from "./parse.ts";
import {
  AttachmentTooLargeError,
  StorageUnavailableError,
  type AttachmentMissHandler,
  type AttachmentRecord,
  type ObjectStorage,
} from "./types.ts";

const USER = "user-a";
const ID = "11111111-1111-4111-8111-111111111111";

function record(over: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: ID,
    userId: USER,
    gmailMessageId: "msg-1",
    threadId: "thread-1",
    partId: "1.2",
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    gmailAttachmentId: "gmail-att-1",
    isInline: false,
    contentId: null,
    cacheStorageKey: null,
    cachedAt: null,
    lastAccessedAt: null,
    ...over,
  };
}

function fakeStore(row: AttachmentRecord | null) {
  const calls = { findOwned: 0, touched: 0 };
  return {
    calls,
    store: {
      async findOwned() {
        calls.findOwned++;
        return row;
      },
      async touchAccessed() {
        calls.touched++;
      },
    },
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(Buffer.from(text));
      c.close();
    },
  });
}

async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
  return Buffer.from(await new Response(body).arrayBuffer()).toString();
}

/** Storage backed by a Map; `fail` makes every read throw like an outage. */
function memoryStorage(objects: Record<string, string> = {}, opts: { fail?: Error; prefix?: string } = {}) {
  const map = new Map(Object.entries(objects));
  const reads: string[] = [];
  const storage: ObjectStorage = {
    enabled: true,
    keyPrefix: opts.prefix ?? "dev",
    async getObject(key) {
      reads.push(key);
      if (opts.fail) throw opts.fail;
      const v = map.get(key);
      return v === undefined ? null : { stream: streamOf(v), contentLength: v.length };
    },
    async putObject(key, body) {
      map.set(key, body.toString());
    },
    async deleteObject(key) {
      map.delete(key);
    },
    async headObject(key) {
      if (opts.fail) throw opts.fail;
      const v = map.get(key);
      return v === undefined ? null : { contentLength: v.length };
    },
  };
  return { storage, map, reads };
}

/** A miss handler spy that "populates" storage the way the API would. */
function missSpy(populate?: (key: string) => void, outcome: "stored" | "not_found" = "stored") {
  const calls: Array<[string, string]> = [];
  const handler: AttachmentMissHandler = async (userId, attachmentId) => {
    calls.push([userId, attachmentId]);
    if (outcome === "not_found") return { status: "not_found" };
    const key = cacheKeyFor({ id: attachmentId, userId }, "dev");
    populate?.(key);
    return { status: "stored", key };
  };
  return { calls, handler };
}

function reset() {
  __resetAttachmentSingleFlight();
  __resetMissHandler();
  delete process.env.API_INTERNAL_URL;
  delete process.env.INTERNAL_API_SECRET;
}

// ── Hit ──────────────────────────────────────────────────────────────

test("a stored object is streamed from storage and the miss handler is never called", async () => {
  reset();
  const key = "dev/attachments/user-a/stored";
  const s = fakeStore(record({ cacheStorageKey: key, cachedAt: new Date() }));
  const { storage } = memoryStorage({ [key]: "stored-bytes" });
  const miss = missSpy();

  const payload = await getAttachmentBytes(USER, ID, { store: s.store, storage, onMiss: miss.handler });

  assert.ok(payload);
  assert.equal(await drain(payload.body), "stored-bytes");
  assert.equal(payload.populated, false);
  assert.equal(miss.calls.length, 0, "a hit never reaches the populator");
  assert.equal(s.calls.touched, 1);
});

// ── Confirmed miss ───────────────────────────────────────────────────

test("no pointer is a confirmed miss: the populator runs, then bytes come FROM STORAGE", async () => {
  reset();
  const s = fakeStore(record());
  const mem = memoryStorage();
  const miss = missSpy((key) => mem.map.set(key, "fresh-from-storage"));

  const payload = await getAttachmentBytes(USER, ID, { store: s.store, storage: mem.storage, onMiss: miss.handler });

  assert.ok(payload);
  assert.equal(miss.calls.length, 1);
  assert.deepEqual(miss.calls[0], [USER, ID]);
  assert.equal(await drain(payload.body), "fresh-from-storage", "served from storage, not from the populator");
  assert.equal(payload.populated, true);
});

test("a pointer with no object behind it (store answered not-found) is a confirmed miss", async () => {
  reset();
  const s = fakeStore(record({ cacheStorageKey: "dev/attachments/user-a/evicted", cachedAt: new Date() }));
  const mem = memoryStorage();
  const miss = missSpy((key) => mem.map.set(key, "repopulated"));

  const payload = await getAttachmentBytes(USER, ID, { store: s.store, storage: mem.storage, onMiss: miss.handler });

  assert.equal(miss.calls.length, 1);
  assert.equal(await drain(payload!.body), "repopulated");
});

// ── Outage is never a miss ───────────────────────────────────────────

test("a storage read OUTAGE is a 503 and never reaches the populator (no Gmail)", async () => {
  reset();
  const s = fakeStore(record({ cacheStorageKey: "dev/attachments/user-a/x", cachedAt: new Date() }));
  const outage = Object.assign(new Error("connect ETIMEDOUT"), { $metadata: { httpStatusCode: 503 } });
  const { storage } = memoryStorage({}, { fail: outage });
  const miss = missSpy();

  await assert.rejects(
    () => getAttachmentBytes(USER, ID, { store: s.store, storage, onMiss: miss.handler }),
    (err: unknown) => err instanceof StorageUnavailableError && err.status === 503,
  );
  assert.equal(miss.calls.length, 0, "an outage must never be treated as a miss");
});

test("a 403 from storage is an outage, not a miss", async () => {
  reset();
  const s = fakeStore(record({ cacheStorageKey: "dev/attachments/user-a/x", cachedAt: new Date() }));
  const forbidden = Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  const { storage } = memoryStorage({}, { fail: forbidden });
  const miss = missSpy();

  await assert.rejects(
    () => getAttachmentBytes(USER, ID, { store: s.store, storage, onMiss: miss.handler }),
    StorageUnavailableError,
  );
  assert.equal(miss.calls.length, 0);
});

test("an object missing right after the populator stored it is an error, not a loop", async () => {
  reset();
  const s = fakeStore(record());
  const mem = memoryStorage();
  const miss = missSpy(); // claims stored, writes nothing

  await assert.rejects(
    () => getAttachmentBytes(USER, ID, { store: s.store, storage: mem.storage, onMiss: miss.handler }),
    StorageUnavailableError,
  );
  assert.equal(miss.calls.length, 1, "asked once, never retried in a loop");
});

// ── Configuration ────────────────────────────────────────────────────

test("storage not configured answers 503 'not configured' and populates nothing", async () => {
  reset();
  const s = fakeStore(record());
  const miss = missSpy();

  await assert.rejects(
    () => getAttachmentBytes(USER, ID, { store: s.store, storage: disabledStorage, onMiss: miss.handler }),
    (err: unknown) => err instanceof StorageUnavailableError && err.reason === "not_configured",
  );
  assert.equal(miss.calls.length, 0);
});

test("a confirmed miss with no registered populator is a 503, never a Gmail call from this process", async () => {
  reset();
  const s = fakeStore(record());
  const { storage } = memoryStorage();

  await assert.rejects(
    () => getAttachmentBytes(USER, ID, { store: s.store, storage }),
    (err: unknown) => err instanceof StorageUnavailableError && err.reason === "not_configured",
  );
});

test("the registry is global: a handler set by another bundled copy of the module is still seen", async () => {
  // Simulates Next.js: instrumentation.ts and the route handler hold different
  // copies of this module; registration must still reach the route's copy.
  reset();
  const s = fakeStore(record());
  const mem = memoryStorage();
  const miss = missSpy((key) => mem.map.set(key, "via-global"));
  (globalThis as Record<symbol, unknown>)[Symbol.for("mailroid.attachments.missHandler")] = miss.handler;

  const payload = await getAttachmentBytes(USER, ID, { store: s.store, storage: mem.storage });
  assert.equal(await drain(payload!.body), "via-global");
  reset();
});

test("with nothing registered, the internal client is built from env (and never calls Gmail)", async () => {
  reset();
  process.env.API_INTERNAL_URL = "http://127.0.0.1:1"; // nothing listens: proves the client was used
  process.env.INTERNAL_API_SECRET = "x".repeat(40);
  const s = fakeStore(record());
  const { storage } = memoryStorage();

  await assert.rejects(
    () => getAttachmentBytes(USER, ID, { store: s.store, storage }),
    (err: unknown) => err instanceof StorageUnavailableError && err.reason === "error",
    "it tried the API (unreachable → unavailable), rather than reporting 'not configured'",
  );
  reset();
});

test("the registered process-level populator is used when none is injected", async () => {
  reset();
  const s = fakeStore(record());
  const mem = memoryStorage();
  const miss = missSpy((key) => mem.map.set(key, "via-registered"));
  setAttachmentMissHandler(miss.handler);

  const payload = await getAttachmentBytes(USER, ID, { store: s.store, storage: mem.storage });
  assert.equal(await drain(payload!.body), "via-registered");
  assert.equal(miss.calls.length, 1);
  setAttachmentMissHandler(null);
});

// ── Ownership and size ───────────────────────────────────────────────

test("another account's attachment is indistinguishable from a missing one", async () => {
  reset();
  const s = fakeStore(null); // findOwned(user-b, id) → null
  const mem = memoryStorage();
  const miss = missSpy();

  const payload = await getAttachmentBytes("user-b", ID, { store: s.store, storage: mem.storage, onMiss: miss.handler });

  assert.equal(payload, null);
  assert.equal(mem.reads.length, 0, "storage is never consulted before ownership");
  assert.equal(miss.calls.length, 0);
});

test("the populator saying not_found is a 404 (null)", async () => {
  reset();
  const s = fakeStore(record());
  const mem = memoryStorage();
  const miss = missSpy(undefined, "not_found");

  const payload = await getAttachmentBytes(USER, ID, { store: s.store, storage: mem.storage, onMiss: miss.handler });
  assert.equal(payload, null);
});

test("an oversized attachment is refused before storage or the populator is touched", async () => {
  reset();
  const s = fakeStore(record({ sizeBytes: MAX_ATTACHMENT_BYTES + 1 }));
  const mem = memoryStorage();
  const miss = missSpy();

  await assert.rejects(
    () => getAttachmentBytes(USER, ID, { store: s.store, storage: mem.storage, onMiss: miss.handler }),
    AttachmentTooLargeError,
  );
  assert.equal(mem.reads.length, 0);
  assert.equal(miss.calls.length, 0);
});

test("a read follows the STORED key, never one recomputed from the row", async () => {
  // The no-migration property: a legacy or differently-prefixed stored key must
  // still be read from where it actually lives.
  reset();
  const legacy = "attachments/user-a/legacy-object";
  const s = fakeStore(record({ cacheStorageKey: legacy, cachedAt: new Date() }));
  const mem = memoryStorage({ [legacy]: "legacy-bytes" });

  const payload = await getAttachmentBytes(USER, ID, { store: s.store, storage: mem.storage, onMiss: missSpy().handler });

  assert.equal(await drain(payload!.body), "legacy-bytes");
  assert.deepEqual(mem.reads, [legacy]);
});

// ── Single-flight helper ─────────────────────────────────────────────

test("concurrent callers for one key share a single run", async () => {
  reset();
  let runs = 0;
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      coalesce("k", async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 5));
        return "done";
      }),
    ),
  );
  assert.equal(runs, 1);
  assert.deepEqual(new Set(results), new Set(["done"]));
});

test("a rejected run never strands its coalescing entry", async () => {
  reset();
  let attempts = 0;
  await assert.rejects(() => coalesce("k", async () => { attempts++; throw new Error("boom"); }));
  await assert.rejects(() => coalesce("k", async () => { attempts++; throw new Error("boom again"); }));
  assert.equal(attempts, 2, "the second caller must be able to try again");
});

// ── The parser ────────────────────────────────────────────────────────

test("extractAttachments finds real attachments and marks inline parts", () => {
  const payload = {
    mimeType: "multipart/mixed",
    partId: "",
    parts: [
      { partId: "0", mimeType: "text/plain", body: { size: 10 } },
      { partId: "1", mimeType: "application/pdf", filename: "invoice.pdf", body: { size: 2048, attachmentId: "att-1" } },
      {
        partId: "2",
        mimeType: "image/png",
        filename: "sig.png",
        headers: [
          { name: "Content-Disposition", value: "inline; filename=\"sig.png\"" },
          { name: "Content-ID", value: "<sig@local>" },
        ],
        body: { size: 512, attachmentId: "att-2" },
      },
      {
        // THE REGRESSION. Gmail's composer puts a Content-ID on every
        // attachment it uploads; reading that as "inline" hid real documents.
        partId: "3",
        mimeType: "application/pdf",
        filename: "report.pdf",
        headers: [
          { name: "Content-Disposition", value: "attachment; filename=\"report.pdf\"" },
          { name: "Content-ID", value: "<f_m9zk1x>" },
          { name: "X-Attachment-Id", value: "f_m9zk1x" },
        ],
        body: { size: 4096, attachmentId: "att-3" },
      },
    ],
  };

  const found = extractAttachments(payload);
  assert.equal(found.length, 3, "the text/plain body part is not an attachment");
  const pdf = found.find((f) => f.filename === "invoice.pdf")!;
  assert.equal(pdf.partId, "1");
  assert.equal(pdf.isInline, false);
  assert.equal(pdf.gmailAttachmentId, "att-1");
  const sig = found.find((f) => f.filename === "sig.png")!;
  assert.equal(sig.isInline, true);
  assert.equal(sig.contentId, "sig@local");
  const gmailComposed = found.find((f) => f.filename === "report.pdf")!;
  assert.equal(gmailComposed.isInline, false, "a Content-ID must NOT override an explicit attachment disposition");
  assert.equal(gmailComposed.contentId, "f_m9zk1x");
  assert.equal(countVisibleAttachments(payload), 2);
});

test("an unnamed part carrying only a Content-ID is still treated as embedded", () => {
  const found = extractAttachments({
    mimeType: "multipart/related",
    parts: [{ partId: "1", mimeType: "image/gif", headers: [{ name: "Content-ID", value: "<logo@local>" }], body: { size: 9, attachmentId: "att-logo" } }],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.isInline, true);
});

test("a part with an attachmentId but no filename still counts", () => {
  const found = extractAttachments({
    mimeType: "multipart/related",
    parts: [{ partId: "1", mimeType: "image/gif", body: { size: 9, attachmentId: "att-x" } }],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.filename, "");
  assert.equal(found[0]!.gmailAttachmentId, "att-x");
});

test("an attached .eml is not flattened into its own sub-parts", () => {
  const found = extractAttachments({
    mimeType: "multipart/mixed",
    parts: [
      {
        partId: "1",
        mimeType: "message/rfc822",
        filename: "forwarded.eml",
        body: { size: 4096, attachmentId: "att-eml" },
        parts: [{ partId: "1.1", mimeType: "text/html", body: { size: 100 } }],
      },
    ],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.filename, "forwarded.eml");
});

// ── Cross-environment isolation ───────────────────────────────────────
// Dev and prod share one bucket; the prefix keeps their objects apart, even
// when a restored dump gives both the identical (userId, id) pair.

test("the same attachment under two prefixes produces two distinct keys", () => {
  const shared = record();
  assert.equal(cacheKeyFor(shared, "dev"), `dev/attachments/${USER}/${shared.id}`);
  assert.equal(cacheKeyFor(shared, "prod"), `prod/attachments/${USER}/${shared.id}`);
});
