/**
 * Tests for download admission — the byte budget and the size gate — now on
 * the API side (ensureAttachmentStored), where Gmail downloads happen.
 *
 * These exist because 155 passing tests once missed that every attachment
 * between 16 and 25 MB was permanently undownloadable: the size gate admitted
 * up to 25 MB while admission charged more than the budget could ever hold.
 * Rule enforced here: **anything the size gate lets through, admission must be
 * able to serve on an idle server.**
 *
 * Admission is charged against the DECLARED size on the row, so a record can
 * claim 25 MB while the fake Gmail returns one byte — cheap to test.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ensureAttachmentStored } from "./ensure-stored.ts";
import {
  __resetInflightBudget,
  MAX_ATTACHMENT_BYTES,
  MAX_CONCURRENT_MISSES_PER_USER,
  MAX_INFLIGHT_DOWNLOAD_BYTES,
  RETAINED_MULTIPLIER,
  admitUpload,
  MAX_INFLIGHT_UPLOAD_BYTES,
  UPLOAD_RETAINED_MULTIPLIER,
} from "./admission.ts";
import { __resetAttachmentSingleFlight } from "./single-flight.ts";
import { AttachmentBusyError, type AttachmentRecord, type ObjectStorage } from "./types.ts";

const MB = 1024 * 1024;
const costOf = (bytes: number) => bytes * RETAINED_MULTIPLIER;
const MAX_FULL_SIZE_CONCURRENT = Math.floor(MAX_INFLIGHT_DOWNLOAD_BYTES / costOf(MAX_ATTACHMENT_BYTES));

function reset() {
  __resetAttachmentSingleFlight();
  __resetInflightBudget();
}

/** Mints a record for whatever id is asked for, at a fixed declared size. */
function sizedStore(sizeBytes: number) {
  return {
    async findOwned(userId: string, id: string): Promise<AttachmentRecord> {
      return {
        id, userId, gmailMessageId: `msg-${id}`, threadId: "t", partId: "1", filename: "big.pdf",
        mimeType: "application/pdf", sizeBytes, gmailAttachmentId: `g-${id}`, isInline: false,
        contentId: null, cacheStorageKey: null, cachedAt: null, lastAccessedAt: null,
      };
    },
    async markCached() {},
    async touchAccessed() {},
  };
}

/** Accepts every write and reports its true size, so verification passes. */
function acceptingStorage(): ObjectStorage {
  const map = new Map<string, Buffer>();
  return {
    enabled: true,
    keyPrefix: "dev",
    async getObject() {
      return null;
    },
    async putObject(key, body) {
      map.set(key, body);
    },
    async deleteObject() {},
    async headObject(key) {
      const v = map.get(key);
      return v ? { contentLength: v.length } : null;
    },
  };
}

/** A Gmail fetch parked until released, so its budget reservation stays held. */
function parkableGmail() {
  const releases: Array<() => void> = [];
  let started = 0;
  let released = false;
  return {
    get started() {
      return started;
    },
    releaseAll() {
      released = true;
      for (const r of releases.splice(0)) r();
    },
    fetch: async () => {
      started++;
      if (!released) await new Promise<void>((resolve) => (released ? resolve() : releases.push(resolve)));
      return Buffer.alloc(1);
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function deps(store: ReturnType<typeof sizedStore>, gmail: ReturnType<typeof parkableGmail>, storage = acceptingStorage()) {
  return { store, storage, fetchFromGmail: gmail.fetch, now: () => new Date() };
}

test("the size gate and the download budget agree (boot guard holds)", () => {
  assert.ok(
    costOf(MAX_ATTACHMENT_BYTES) <= MAX_INFLIGHT_DOWNLOAD_BYTES,
    "a size the gate admits must fit the budget, or sizes in between would 503 forever",
  );
  assert.ok(MAX_FULL_SIZE_CONCURRENT >= 1);
});

for (const sizeMb of [16, 18, 20, 25]) {
  test(`${sizeMb} MB attachment is admitted on an idle server`, async () => {
    reset();
    const gmail = parkableGmail();
    gmail.releaseAll();
    const out = await ensureAttachmentStored("u1", uuid(1), deps(sizedStore(sizeMb * MB), gmail));
    assert.equal(out.status, "stored");
  });
}

test(`the budget admits ${MAX_FULL_SIZE_CONCURRENT} full-size downloads at once, then refuses`, async () => {
  reset();
  const store = sizedStore(MAX_ATTACHMENT_BYTES);
  const gmail = parkableGmail();

  // Distinct users so the per-user cap is not what refuses.
  const inFlight = Array.from({ length: MAX_FULL_SIZE_CONCURRENT }, (_, i) =>
    ensureAttachmentStored(`u${i}`, uuid(i), deps(store, gmail)),
  );
  await tick();
  assert.equal(gmail.started, MAX_FULL_SIZE_CONCURRENT);

  await assert.rejects(() => ensureAttachmentStored("u-over", uuid(99), deps(store, gmail)), AttachmentBusyError);

  gmail.releaseAll();
  await Promise.all(inFlight);

  // Released after completion: the next one is admitted.
  const after = await ensureAttachmentStored("u-over", uuid(99), deps(store, gmail));
  assert.equal(after.status, "stored");
});

test("the per-user cap refuses one user's extra concurrent downloads but not another user's", async () => {
  reset();
  const store = sizedStore(1 * MB);
  const gmail = parkableGmail();

  const mine = Array.from({ length: MAX_CONCURRENT_MISSES_PER_USER }, (_, i) =>
    ensureAttachmentStored("solo", uuid(i), deps(store, gmail)),
  );
  await tick();
  await assert.rejects(() => ensureAttachmentStored("solo", uuid(50), deps(store, gmail)), AttachmentBusyError);

  const other = ensureAttachmentStored("other", uuid(60), deps(store, gmail));
  gmail.releaseAll();
  await Promise.all([...mine, other]);
});

test("a failed Gmail fetch releases its budget", async () => {
  reset();
  const store = sizedStore(MAX_ATTACHMENT_BYTES);
  const failing = { fetch: async () => { throw new Error("gmail 500"); } };

  for (let i = 0; i < MAX_FULL_SIZE_CONCURRENT + 2; i++) {
    await assert.rejects(() =>
      ensureAttachmentStored(`u${i}`, uuid(i), { store, storage: acceptingStorage(), fetchFromGmail: failing.fetch }),
    );
  }
  // If failures leaked budget, this would be refused as busy.
  const gmail = parkableGmail();
  gmail.releaseAll();
  const out = await ensureAttachmentStored("u-final", uuid(200), deps(store, gmail));
  assert.equal(out.status, "stored");
});

test("uploads have their own budget (web container) and their own guard", () => {
  reset();
  assert.ok(
    MAX_INFLIGHT_UPLOAD_BYTES >= 0 && UPLOAD_RETAINED_MULTIPLIER > 0,
    "upload constants exist independently of the download budget",
  );
  const release = admitUpload("u1", 1 * MB);
  assert.throws(() => admitUpload("u1", 1 * MB), AttachmentBusyError, "one upload per user at a time");
  release();
  admitUpload("u1", 1 * MB)();
});
