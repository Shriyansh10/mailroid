import { strict as assert } from "node:assert";
import { test } from "node:test";

import { purgeUserObjects, scanUserPrefix, scanVerifies, userPrefix, type DeletionObjectStore } from "./storage.ts";

/** In-memory bucket with paging and failure injection. */
function fakeStore(opts: {
  objects: string[];
  uploads?: { key: string; uploadId: string }[];
  pageSize?: number;
  failDelete?: (key: string) => boolean;
  failList?: boolean;
  failUploadList?: boolean;
}) {
  const objects = new Set(opts.objects);
  const uploads = [...(opts.uploads ?? [])];
  const page = opts.pageSize ?? 2;
  const calls = { deleted: [] as string[], aborted: [] as string[], listedPrefixes: [] as string[] };
  const store: DeletionObjectStore = {
    keyPrefix: "dev",
    async listObjects(prefix, token) {
      calls.listedPrefixes.push(prefix);
      if (opts.failList) throw Object.assign(new Error("boom"), { name: "InternalError" });
      const all = [...objects].filter((k) => k.startsWith(prefix)).sort();
      const start = token ? Number(token) : 0;
      const keys = all.slice(start, start + page);
      return { keys, next: start + page < all.length ? String(start + page) : undefined };
    },
    async listUploads(prefix, marker) {
      if (opts.failUploadList) throw new Error("multipart boom");
      const all = uploads.filter((u) => u.key.startsWith(prefix));
      const start = marker ? all.findIndex((u) => u.uploadId === marker.uploadId) + 1 : 0;
      const slice = all.slice(start, start + page);
      const last = slice[slice.length - 1];
      return { uploads: slice, next: start + page < all.length && last ? last : undefined };
    },
    async deleteObject(key) {
      if (opts.failDelete?.(key)) throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      objects.delete(key);
      calls.deleted.push(key);
    },
    async abortUpload(key, uploadId) {
      const i = uploads.findIndex((u) => u.uploadId === uploadId);
      if (i >= 0) uploads.splice(i, 1);
      calls.aborted.push(`${key}#${uploadId}`);
    },
  };
  return { store, objects, uploads, calls };
}

test("userPrefix never yields a parent prefix", () => {
  assert.equal(userPrefix("dev", "u1"), "dev/attachments/u1/");
  for (const bad of ["", "a/b", "..", " u1", "u1 "]) assert.throws(() => userPrefix("dev", bad), bad);
  assert.throws(() => userPrefix("Dev", "u1"));
});

test("purge deletes every page of the user's prefix and nothing of anyone else's", async () => {
  const mine = ["dev/attachments/u1/a", "dev/attachments/u1/b", "dev/attachments/u1/c", "dev/attachments/u1/d", "dev/attachments/u1/e"];
  const theirs = ["dev/attachments/u10/a", "dev/attachments/u2/a"];
  const f = fakeStore({ objects: [...mine, ...theirs] });
  const r = await purgeUserObjects(f.store, "u1", []);
  assert.equal(r.complete, true);
  assert.equal(r.deleted, 5);
  assert.deepEqual([...f.objects].sort(), theirs.sort());
  // u10 shares a string prefix with u1 — the trailing slash is what protects it.
  assert.ok(f.calls.listedPrefixes.every((p) => p === "dev/attachments/u1/"));
});

test("unfinished multipart uploads are aborted, across pages", async () => {
  const f = fakeStore({
    objects: [],
    uploads: [
      { key: "dev/attachments/u1/x", uploadId: "1" },
      { key: "dev/attachments/u1/y", uploadId: "2" },
      { key: "dev/attachments/u1/z", uploadId: "3" },
      { key: "dev/attachments/u2/q", uploadId: "4" },
    ],
  });
  const r = await purgeUserObjects(f.store, "u1", []);
  assert.equal(r.abortedUploads, 3);
  assert.deepEqual(f.uploads.map((u) => u.uploadId), ["4"]);
  assert.equal(r.complete, true);
});

test("a single failed delete makes the purge incomplete and is reported with its error", async () => {
  const f = fakeStore({ objects: ["dev/attachments/u1/a", "dev/attachments/u1/b"], failDelete: (k) => k.endsWith("/b") });
  const r = await purgeUserObjects(f.store, "u1", []);
  assert.equal(r.complete, false);
  assert.equal(r.deleted, 1);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0]!.error, /AccessDenied.*403/);
});

test("a listing failure fails closed — never reported complete", async () => {
  const f = fakeStore({ objects: ["dev/attachments/u1/a"], failList: true });
  const r = await purgeUserObjects(f.store, "u1", []);
  assert.equal(r.complete, false);
  const u = fakeStore({ objects: [], failUploadList: true });
  assert.equal((await purgeUserObjects(u.store, "u1", [])).complete, false);
});

test("recorded keys under another user's prefix are refused, not deleted", async () => {
  const f = fakeStore({ objects: ["dev/attachments/u2/a"] });
  const r = await purgeUserObjects(f.store, "u1", ["dev/attachments/u2/a"]);
  assert.equal(r.complete, false);
  assert.deepEqual([...f.objects], ["dev/attachments/u2/a"]);
});

test("a scan verifies only when complete, empty, and started after T_last", async () => {
  const tLast = new Date("2026-10-28T10:15:00Z");
  const empty = fakeStore({ objects: [] });
  const after = await scanUserPrefix(empty.store, "u1", () => new Date("2026-10-28T22:00:00Z"));
  assert.equal(scanVerifies(after, tLast), true);
  const before = await scanUserPrefix(empty.store, "u1", () => new Date("2026-10-28T10:00:00Z"));
  assert.equal(scanVerifies(before, tLast), false);
  assert.equal(scanVerifies(after, null), false);

  const late = fakeStore({ objects: ["dev/attachments/u1/late"] });
  const found = await scanUserPrefix(late.store, "u1", () => new Date("2026-10-29T00:00:00Z"));
  assert.equal(found.objects, 1);
  assert.equal(scanVerifies(found, tLast), false);

  const broken = fakeStore({ objects: [], failList: true });
  const failed = await scanUserPrefix(broken.store, "u1", () => new Date("2026-10-29T00:00:00Z"));
  assert.equal(failed.complete, false);
  assert.equal(scanVerifies(failed, tLast), false);
});

test("a pending multipart upload alone stops verification", async () => {
  const f = fakeStore({ objects: [], uploads: [{ key: "dev/attachments/u1/x", uploadId: "1" }] });
  const scan = await scanUserPrefix(f.store, "u1", () => new Date("2027-01-01"));
  assert.equal(scan.uploads, 1);
  assert.equal(scanVerifies(scan, new Date("2026-01-01")), false);
});
