/**
 * Tests for one thread of the attachment-manifest backfill (no DB, no Gmail).
 *
 * Guards:
 *   - every message in the thread gets its manifest written (and so stamped),
 *     including messages with no real attachment;
 *   - a structure deeper than the mask writes NOTHING and is skipped, never a
 *     partial manifest;
 *   - paused / cooling / rate-limited / paced-out stops the run without
 *     recording a failure against the thread;
 *   - an ordinary failure is recorded (attempts), so the thread is retried at
 *     most a bounded number of times.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { manifestOneThread } from "./attachment-manifest-backfill.ts";
import { GmailPacedOutError } from "./gmail-errors.ts";
import { GmailStructureError, type StructuredThread } from "../attachments/structure.ts";

const USER = "user-1";
const THREAD = "thread-1";

function harness(thread: StructuredThread | Error) {
  const calls = {
    gate: 0,
    fetched: 0,
    replaced: [] as Array<{ messageId: string; tiles: number; total: number }>,
    failures: [] as string[],
    cooldowns: 0,
  };
  const deps = {
    assertSyncAllowed: async () => { calls.gate++; },
    fetchThreadStructure: async () => {
      calls.fetched++;
      if (thread instanceof Error) throw thread;
      return thread;
    },
    replaceAttachmentManifest: async (_u: string, messageId: string, _t: string | null, parts: Array<{ isInline: boolean }>) => {
      calls.replaced.push({ messageId, tiles: parts.filter((p) => !p.isInline).length, total: parts.length });
    },
    recordManifestFailure: async (_u: string, _t: string, reason: "failed" | "too_deep") => { calls.failures.push(reason); },
    handleGmailFailure: async () => { calls.cooldowns++; },
  };
  return { calls, deps };
}

const pdf = (partId: string) => ({ partId, mimeType: "application/pdf", filename: `${partId}.pdf`, body: { size: 10, attachmentId: `a-${partId}` } });

test("a 3-message thread: every message gets its manifest (and stamp), including one with no attachment", async () => {
  const h = harness({
    id: THREAD,
    messages: [
      { id: "m1", payload: { mimeType: "multipart/mixed", parts: [{ partId: "0", mimeType: "text/plain", body: { size: 1 } }, pdf("1")] } },
      { id: "m2", payload: { mimeType: "multipart/mixed", parts: [{ partId: "0", mimeType: "text/plain", body: { size: 1 } }] } },
      {
        id: "m3",
        payload: {
          mimeType: "multipart/related",
          parts: [
            { partId: "0", mimeType: "text/html", body: { size: 1 } },
            { partId: "1", mimeType: "image/png", headers: [{ name: "Content-ID", value: "<logo>" }], body: { size: 5, attachmentId: "a-logo" } },
          ],
        },
      },
    ],
  });

  assert.equal(await manifestOneThread(USER, THREAD, h.deps), "done");
  assert.deepEqual(
    h.calls.replaced.map((r) => [r.messageId, r.tiles]),
    [["m1", 1], ["m2", 0], ["m3", 0]],
    "all three written; m2 (mixed, no attachment) and m3 (inline only) show no tiles but are still stamped",
  );
  assert.equal(h.calls.replaced[2]!.total, 1, "the inline image is stored for cid: resolution");
  assert.deepEqual(h.calls.failures, []);
});

test("a structure deeper than the mask writes NO manifest and is skipped as too_deep", async () => {
  const h = harness({
    id: THREAD,
    messages: [
      { id: "m1", payload: { mimeType: "multipart/mixed", parts: [pdf("1")] } },
      { id: "m2", payload: { mimeType: "multipart/mixed", parts: [pdf("1"), { partId: "2", mimeType: "multipart/mixed" }] } },
    ],
  });

  assert.equal(await manifestOneThread(USER, THREAD, h.deps), "too_deep");
  assert.deepEqual(h.calls.replaced, [], "not even the complete message: the thread is all-or-nothing");
  assert.deepEqual(h.calls.failures, ["too_deep"]);
});

test("a paused or cooling mailbox stops the run before any request, with no failure recorded", async () => {
  const h = harness({ id: THREAD, messages: [] });
  const deps = { ...h.deps, assertSyncAllowed: async () => { throw Object.assign(new Error("paused"), { status: 503 }); } };

  assert.equal(await manifestOneThread(USER, THREAD, deps), "stop");
  assert.equal(h.calls.fetched, 0);
  assert.deepEqual(h.calls.failures, []);
});

test("the pacer declining stops the run without counting against the thread", async () => {
  const h = harness(new GmailPacedOutError({ tenantId: USER, operation: "threads.get", trigger: "manifest-backfill", waitMs: 1, capMs: 0 }));
  assert.equal(await manifestOneThread(USER, THREAD, h.deps), "stop");
  assert.deepEqual(h.calls.failures, []);
});

test("a 429 records a cooldown and stops; it is not counted as a thread failure", async () => {
  const h = harness(new GmailStructureError(429, "rate limited", { error: { code: 429, status: "RESOURCE_EXHAUSTED" } }));
  assert.equal(await manifestOneThread(USER, THREAD, h.deps), "stop");
  assert.equal(h.calls.cooldowns, 1);
  assert.deepEqual(h.calls.failures, []);
});

test("an ordinary failure is recorded against the thread (bounded retries)", async () => {
  const h = harness(new GmailStructureError(500, "backend error"));
  assert.equal(await manifestOneThread(USER, THREAD, h.deps), "failed");
  assert.deepEqual(h.calls.failures, ["failed"]);
  assert.deepEqual(h.calls.replaced, []);
});
