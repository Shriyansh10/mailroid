/**
 * Tests for the metadata-only structure reads: the `fields` mask must never ask
 * for body data, must reach deep enough for real mail, and a tree deeper than
 * the mask must be reported as incomplete — never as "no more attachments".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isStructureTruncated,
  MESSAGE_STRUCTURE_FIELDS,
  partMask,
  STRUCTURE_MASK_DEPTH,
  THREAD_STRUCTURE_FIELDS,
} from "./structure.ts";
import { extractAttachments, type ParsablePart } from "./parse.ts";

test("the masks never name `data`, at any depth", () => {
  for (const mask of [partMask(), MESSAGE_STRUCTURE_FIELDS, THREAD_STRUCTURE_FIELDS]) {
    assert.ok(!/\bdata\b/.test(mask), mask);
  }
});

test("the mask asks for exactly what extractAttachments reads", () => {
  for (const field of ["partId", "mimeType", "filename", "headers(name,value)", "body(size,attachmentId)"]) {
    assert.ok(partMask(0).includes(field), `missing ${field}`);
  }
});

test(`the mask nests parts ${STRUCTURE_MASK_DEPTH} levels deep`, () => {
  assert.equal((partMask().match(/parts\(/g) ?? []).length, STRUCTURE_MASK_DEPTH);
});

const leaf = (partId: string, over: Partial<ParsablePart> = {}): ParsablePart => ({
  partId, mimeType: "application/pdf", filename: `${partId}.pdf`, body: { size: 10, attachmentId: `att-${partId}` }, ...over,
});

test("MIME shapes: ordinary, inline cid, nested mixed→related→alternative, and no-attachment mixed", () => {
  const ordinary: ParsablePart = { mimeType: "multipart/mixed", parts: [{ partId: "0", mimeType: "text/plain", body: { size: 3 } }, leaf("1")] };
  assert.equal(isStructureTruncated(ordinary), false);
  assert.equal(extractAttachments(ordinary).filter((a) => !a.isInline).length, 1);

  const inline: ParsablePart = {
    mimeType: "multipart/related",
    parts: [
      { partId: "0", mimeType: "text/html", body: { size: 3 } },
      { partId: "1", mimeType: "image/png", headers: [{ name: "Content-ID", value: "<logo>" }], body: { size: 9, attachmentId: "att-logo" } },
    ],
  };
  const inlineFound = extractAttachments(inline);
  assert.equal(inlineFound.length, 1);
  assert.equal(inlineFound[0]!.isInline, true, "an inline cid image is not a list tile");

  const nested: ParsablePart = {
    mimeType: "multipart/mixed",
    parts: [
      {
        partId: "0", mimeType: "multipart/related",
        parts: [{ partId: "0.0", mimeType: "multipart/alternative", parts: [{ partId: "0.0.0", mimeType: "text/plain", body: { size: 1 } }] }],
      },
      leaf("1"),
    ],
  };
  assert.equal(isStructureTruncated(nested), false);
  assert.equal(extractAttachments(nested).length, 1);

  const noAttachment: ParsablePart = { mimeType: "multipart/mixed", parts: [{ partId: "0", mimeType: "text/plain", body: { size: 1 } }] };
  assert.equal(isStructureTruncated(noAttachment), false, "complete, just empty");
  assert.equal(extractAttachments(noAttachment).length, 0);
});

test("a multipart container that came back without children is reported as truncated", () => {
  // What Gmail returns when the tree is deeper than the mask: the container's
  // own fields, but no `parts`, because the mask stopped asking.
  const deep: ParsablePart = {
    mimeType: "multipart/mixed",
    parts: [leaf("1"), { partId: "2", mimeType: "multipart/mixed" }],
  };
  assert.equal(isStructureTruncated(deep), true);
});

test("the real thread request goes through the shared controls and never asks for content", async () => {
  const { fetchThreadStructure } = await import("./structure.ts");
  const seen: string[] = [];
  const spies = { quota: 0, slots: 0 };
  const thread = await fetchThreadStructure("tenant-1", "thread-9", {
    ctx: { trigger: "manifest-backfill", operation: "threads.get" },
    hooks: {
      getAccessToken: async () => "token",
      resolveMailbox: async () => undefined,
      quota: { acquire: async () => { spies.quota++; return { waitedMs: 0, units: 0 }; }, charge: () => {} },
      acquireMailboxSlot: async () => { spies.slots++; return () => {}; },
      fetchImpl: (async (input: string | URL) => {
        seen.push(String(input));
        return Response.json({ id: "thread-9", messages: [{ id: "m1", payload: { mimeType: "multipart/mixed", parts: [] } }] });
      }) as typeof fetch,
    },
  });

  assert.equal(thread.messages.length, 1);
  assert.equal(seen.length, 1);
  const url = new URL(seen[0]!);
  assert.equal(url.pathname, "/gmail/v1/users/me/threads/thread-9");
  const fields = url.searchParams.get("fields") ?? "";
  assert.ok(fields.startsWith("id,messages("), fields);
  assert.ok(!/\bdata\b/.test(fields), "Gmail is never asked for body data");
  assert.equal(spies.quota, 1, "paced");
  assert.equal(spies.slots, 1, "held a mailbox slot");
});
