/**
 * Tests for settleDraftAttachments — draft files survive Gmail's new records
 * on every save, without re-downloading and without orphaning objects.
 * No DB, no network: object-literal collaborators.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { settleDraftAttachments, type OutgoingDraftFile } from "./draft-attachments.ts";
import type { AttachmentRecord, ObjectStorage } from "../attachments/types.ts";

const USER = "user-1";
const DRAFT = "draft-1";

function row(id: string, over: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id, userId: USER, gmailMessageId: "msg-new", threadId: "t", partId: id, filename: `${id}.pdf`,
    mimeType: "application/pdf", sizeBytes: 3, gmailAttachmentId: `g-${id}`, isInline: false,
    contentId: null, cacheStorageKey: null, cachedAt: null, lastAccessedAt: null, ...over,
  };
}

const file = (filename: string, text: string, storedKey: string | null = null): OutgoingDraftFile => ({
  filename, content: Buffer.from(text), storedKey,
});

function harness(newRows: AttachmentRecord[], opts: { putFails?: boolean; deleteFails?: boolean; references?: Record<string, number>; structureFails?: boolean } = {}) {
  const calls = {
    marked: [] as Array<[string, string]>,
    put: [] as string[],
    deletedObjects: [] as string[],
    deletedRows: [] as string[],
    evictionDue: [] as string[],
  };
  const objects = new Map<string, number>();
  const storage: ObjectStorage = {
    enabled: true,
    keyPrefix: "dev",
    async getObject() { return null; },
    async putObject(key, body) {
      calls.put.push(key);
      if (opts.putFails) throw new Error("PUT 500");
      objects.set(key, body.length);
    },
    async deleteObject(key) {
      if (opts.deleteFails) throw new Error("DELETE timeout");
      calls.deletedObjects.push(key);
    },
    async headObject(key) {
      const n = objects.get(key);
      return n === undefined ? null : { contentLength: n };
    },
  };
  const deps = {
    storage,
    now: () => new Date(0),
    fetchDraftStructure: async () => {
      if (opts.structureFails) throw new Error("Gmail 500");
      return { id: "msg-new", threadId: "t", payload: { mimeType: "multipart/mixed", parts: newRows.map((r) => ({ partId: r.partId, filename: r.filename, mimeType: r.mimeType, body: { size: r.sizeBytes, attachmentId: r.gmailAttachmentId } })) } };
    },
    replaceAttachmentManifest: async () => {},
    listMessageAttachments: async () => newRows,
    markCached: async (id: string, key: string) => { calls.marked.push([id, key]); },
    countKeyReferences: async (key: string) => opts.references?.[key] ?? 0,
    deleteAttachmentRows: async (ids: string[]) => { calls.deletedRows.push(...ids); },
    makeEvictionDue: async (id: string) => { calls.evictionDue.push(id); },
  };
  return { calls, deps };
}

test("a kept file is carried (no upload); a new upload is stored, verified, then marked", async () => {
  const h = harness([row("n1"), row("n2")]);
  const previous = [row("o1", { gmailMessageId: "msg-old", cacheStorageKey: "dev/attachments/user-1/o1" })];

  const r = await settleDraftAttachments(USER, DRAFT, previous, [file("n1.pdf", "abc", "dev/attachments/user-1/o1"), file("n2.pdf", "xyz")], h.deps);

  assert.deepEqual(h.calls.marked, [
    ["n1", "dev/attachments/user-1/o1"],
    ["n2", "dev/attachments/user-1/n2"],
  ]);
  assert.deepEqual(h.calls.put, ["dev/attachments/user-1/n2"], "only the new upload is written; the kept file is not re-uploaded");
  assert.deepEqual(h.calls.deletedObjects, [], "the carried object is still in use");
  assert.deepEqual(h.calls.deletedRows, ["o1"], "the replaced message's record goes");
  assert.equal(r.carried, 1);
  assert.equal(r.stored, 1);
});

test("a file removed from the draft has its object deleted when nothing else references it", async () => {
  const h = harness([]);
  const previous = [row("o1", { cacheStorageKey: "dev/attachments/user-1/o1" })];

  const r = await settleDraftAttachments(USER, DRAFT, previous, [], h.deps);
  assert.deepEqual(h.calls.deletedObjects, ["dev/attachments/user-1/o1"]);
  assert.deepEqual(h.calls.deletedRows, ["o1"]);
  assert.equal(r.removedObjects, 1);
});

test("an object still referenced by another record is never deleted", async () => {
  const h = harness([], { references: { "dev/attachments/user-1/o1": 1 } });
  await settleDraftAttachments(USER, DRAFT, [row("o1", { cacheStorageKey: "dev/attachments/user-1/o1" })], [], h.deps);
  assert.deepEqual(h.calls.deletedObjects, []);
  assert.deepEqual(h.calls.deletedRows, ["o1"], "the stale record goes; the shared object stays");
});

test("a failed delete keeps the record and queues it for the eviction sweep (never a silent orphan)", async () => {
  const h = harness([], { deleteFails: true });
  const r = await settleDraftAttachments(USER, DRAFT, [row("o1", { cacheStorageKey: "dev/attachments/user-1/o1" })], [], h.deps);
  assert.deepEqual(h.calls.evictionDue, ["o1"]);
  assert.deepEqual(h.calls.deletedRows, [], "the record survives so the sweep can find the object");
  assert.equal(r.deleteFailures, 1);
});

test("a failed upload store leaves the record unmarked (fetched from Gmail later), and does not throw", async () => {
  const h = harness([row("n1")], { putFails: true });
  const r = await settleDraftAttachments(USER, DRAFT, [], [file("n1.pdf", "abc")], h.deps);
  assert.deepEqual(h.calls.marked, [], "never marked stored on a failed write");
  assert.equal(r.storeFailures, 1);
});

test("parts that do not line up (name or size) carry nothing: no guess", async () => {
  const h = harness([row("n1", { filename: "renamed.pdf" })]);
  const r = await settleDraftAttachments(USER, DRAFT, [], [file("n1.pdf", "abc", "dev/attachments/user-1/o1")], h.deps);
  assert.equal(r.unmatched, true);
  assert.deepEqual(h.calls.marked, []);
  assert.deepEqual(h.calls.put, []);

  const sizeOff = harness([row("n1", { sizeBytes: 99 })]);
  const r2 = await settleDraftAttachments(USER, DRAFT, [], [file("n1.pdf", "abc")], sizeOff.deps);
  assert.equal(r2.unmatched, true);
  assert.deepEqual(sizeOff.calls.marked, []);
});

test("a failed structure read never fails the save; nothing is marked", async () => {
  const h = harness([row("n1")], { structureFails: true });
  const r = await settleDraftAttachments(USER, DRAFT, [], [file("n1.pdf", "abc")], h.deps);
  assert.deepEqual(h.calls.marked, []);
  assert.equal(r.carried + r.stored, 0);
});
