/**
 * Tests for the forward attachment invariant: the original's files go, or
 * nothing does — and nothing means `send` is never reached.
 * No DB, no network: object-literal collaborators.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectForwardAttachments,
  forwardWithOriginalAttachments,
  ForwardAttachmentsUnavailableError,
  FORWARD_ATTACHMENTS_UNAVAILABLE,
  type ForwardCarryDeps,
} from "./forward-attachments.ts";
import type { AttachmentMeta, AttachmentPayload, AttachmentRecord } from "../attachments/types.ts";
import type { OutgoingAttachment } from "./mime.ts";

const USER = "user-1";
const MSG = "msg-1";

function part(partId: string, over: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    partId, filename: `${partId}.pdf`, mimeType: "application/pdf", sizeBytes: 4,
    gmailAttachmentId: `g-${partId}`, isInline: false, contentId: null, ...over,
  };
}

function rowFor(meta: AttachmentMeta): AttachmentRecord {
  return {
    ...meta, id: `id-${meta.partId}`, userId: USER, gmailMessageId: MSG, threadId: "t-1",
    cacheStorageKey: null, cachedAt: null, lastAccessedAt: null,
  };
}

function payload(text: string): AttachmentPayload {
  return {
    body: new Response(text).body!,
    contentLength: text.length,
  } as unknown as AttachmentPayload;
}

/**
 * A store holding `stored` rows, whose bytes resolve per id: a string is the
 * content, `null` is "not found / not yours", an Error is thrown.
 */
function harness(stored: AttachmentMeta[], bytes: Record<string, string | null | Error>) {
  const calls = { replaced: [] as AttachmentMeta[][], read: [] as string[] };
  let rows = stored.map(rowFor);
  const deps: ForwardCarryDeps = {
    async listMessageAttachments() { return rows; },
    async replaceAttachmentManifest(_u, _m, _t, parsed) {
      calls.replaced.push(parsed);
      rows = parsed.map(rowFor);
    },
    async getAttachmentBytes(_u, id) {
      calls.read.push(id);
      const b = bytes[id];
      if (b instanceof Error) throw b;
      return b === null || b === undefined ? null : payload(b);
    },
  };
  return { deps, calls };
}

const original = (parsed: AttachmentMeta[]) => ({ gmailMessageId: MSG, threadId: "t-1", parsed });

function sendSpy() {
  const sent: OutgoingAttachment[][] = [];
  return { sent, send: async (all: OutgoingAttachment[]) => { sent.push(all); return { id: "sent-1" }; } };
}

test("carries every non-inline part of the original", async () => {
  const parts = [part("1"), part("2")];
  const { deps } = harness(parts, { "id-1": "aaaa", "id-2": "bbbb" });
  const carried = await collectForwardAttachments(USER, original(parts), deps);
  assert.deepEqual(carried.map((c) => [c.filename, c.content.toString()]), [["1.pdf", "aaaa"], ["2.pdf", "bbbb"]]);
});

test("a never-stored manifest is written from the live payload, then carried", async () => {
  const parts = [part("1"), part("2", { isInline: true, filename: "logo.png" })];
  const { deps, calls } = harness([], { "id-1": "aaaa" });
  const carried = await collectForwardAttachments(USER, original(parts), deps);
  // Written with the FULL list, inline included — the manifest is the
  // complete truth for the message.
  assert.equal(calls.replaced.length, 1);
  assert.deepEqual(calls.replaced[0]!.map((p) => p.partId), ["1", "2"]);
  assert.deepEqual(carried.map((c) => c.filename), ["1.pdf"]);
});

test("inline cid: parts are never expected, so they cannot fail a forward", async () => {
  const parts = [part("1"), part("2", { isInline: true, filename: "signature.png" })];
  // The inline part's bytes are unavailable — and it does not matter.
  const { deps, calls } = harness(parts, { "id-1": "aaaa", "id-2": null });
  const carried = await collectForwardAttachments(USER, original(parts), deps);
  assert.deepEqual(carried.map((c) => c.filename), ["1.pdf"]);
  assert.deepEqual(calls.read, ["id-1"]);
});

test("one of three files gone: throws naming it, and send is never called", async () => {
  const parts = [part("1"), part("2", { filename: "contract.pdf" }), part("3")];
  const gone = Object.assign(new Error("gone"), { status: 404 });
  const { deps } = harness(parts, { "id-1": "aaaa", "id-2": gone, "id-3": "cccc" });
  const spy = sendSpy();

  await assert.rejects(
    forwardWithOriginalAttachments(USER, {
      original: original(parts), extra: [], omitOriginalAttachments: false, send: spy.send,
    }, deps),
    (err: unknown) => {
      assert.ok(err instanceof ForwardAttachmentsUnavailableError);
      assert.equal(err.code, FORWARD_ATTACHMENTS_UNAVAILABLE);
      assert.deepEqual(err.filenames, ["contract.pdf"]);
      assert.match(err.message, /"contract\.pdf".*nothing was sent/);
      return true;
    },
  );
  assert.equal(spy.sent.length, 0);
});

test("a row that no longer exists (null) counts as missing", async () => {
  const parts = [part("1")];
  const { deps } = harness(parts, { "id-1": null });
  await assert.rejects(collectForwardAttachments(USER, original(parts), deps), ForwardAttachmentsUnavailableError);
});

test("a transient failure keeps its own error — it is not reported as 'gone'", async () => {
  const parts = [part("1")];
  const busy = Object.assign(new Error("storage down"), { status: 503 });
  const { deps } = harness(parts, { "id-1": busy });
  await assert.rejects(collectForwardAttachments(USER, original(parts), deps), (err: unknown) => {
    assert.ok(!(err instanceof ForwardAttachmentsUnavailableError));
    assert.equal((err as { status?: number }).status, 503);
    return true;
  });
});

test("an original too large to forward fails before any byte is read", async () => {
  const parts = [part("1", { sizeBytes: 30 * 1024 * 1024 })];
  const { deps, calls } = harness(parts, { "id-1": "aaaa" });
  await assert.rejects(collectForwardAttachments(USER, original(parts), deps), (err: unknown) => {
    assert.ok(err instanceof ForwardAttachmentsUnavailableError);
    assert.equal(err.reason, "too_large");
    return true;
  });
  assert.deepEqual(calls.read, []);
});

test("omitOriginalAttachments: sent exactly once, without the original's files", async () => {
  const parts = [part("1")];
  const { deps, calls } = harness(parts, { "id-1": null });
  const spy = sendSpy();
  const extra: OutgoingAttachment = { filename: "mine.txt", mimeType: "text/plain", content: Buffer.from("x") };

  const result = await forwardWithOriginalAttachments(USER, {
    original: original(parts), extra: [extra], omitOriginalAttachments: true, send: spy.send,
  }, deps);

  assert.deepEqual(result, { id: "sent-1" });
  assert.equal(spy.sent.length, 1);
  assert.deepEqual(spy.sent[0]!.map((a) => a.filename), ["mine.txt"]);
  assert.deepEqual(calls.read, [], "the original's files are not even read");
});

test("the sender's own files are added after the original's", async () => {
  const parts = [part("1")];
  const { deps } = harness(parts, { "id-1": "aaaa" });
  const spy = sendSpy();
  await forwardWithOriginalAttachments(USER, {
    original: original(parts),
    extra: [{ filename: "mine.txt", mimeType: "text/plain", content: Buffer.from("x") }],
    omitOriginalAttachments: false,
    send: spy.send,
  }, deps);
  assert.deepEqual(spy.sent[0]!.map((a) => a.filename), ["1.pdf", "mine.txt"]);
});

test("unnamed missing parts are still counted in the message", () => {
  const err = new ForwardAttachmentsUnavailableError("missing", ["a.pdf", ""]);
  assert.match(err.message, /"a\.pdf" and 1 file on the original are no longer available/);
});
