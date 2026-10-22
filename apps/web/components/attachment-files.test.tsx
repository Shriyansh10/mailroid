/**
 * Tests for files entering a compose box by pick, drop or paste: identity,
 * pasted-image naming, text-vs-file pastes, and that the count limit is left
 * to the shared verdict rather than silently enforced by dropping files.
 *
 *   node --import tsx --test components/attachment-files.test.tsx   (from apps/web)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  dragHasFiles,
  filesFromPaste,
  mergeFiles,
  namePastedFile,
} from "./inbox/attachment-files";
import {
  MAX_ATTACHMENT_COUNT,
  validateOutgoingAttachments,
} from "@repo/services/gmail/attachment-limits";

const file = (name: string, body = "abc", lastModified = 1_000, type = "application/pdf") =>
  new File([body], name, { type, lastModified });

/** A clipboard as the browser presents it. */
const clipboard = (files: File[], text = "") => ({
  files: Object.assign([...files], { item: (i: number) => files[i] ?? null }) as unknown as FileList,
  getData: (type: string) => (type === "text/plain" ? text : ""),
});

test("two different files sharing name and size are both kept", () => {
  const a = file("scan.pdf", "abc", 1_000);
  const b = file("scan.pdf", "xyz", 2_000);
  assert.equal(mergeFiles([a], [b]).length, 2);
});

test("the same file picked twice is kept once", () => {
  const a = file("scan.pdf", "abc", 1_000);
  assert.equal(mergeFiles([a], [a]).length, 1);
  // ...including a repeat inside one selection.
  assert.equal(mergeFiles([], [a, a]).length, 1);
});

test("a lastModified of 0 still yields a stable identity", () => {
  const a = file("x.pdf", "abc", 0);
  const again = file("x.pdf", "abc", 0);
  assert.equal(mergeFiles([a], [again]).length, 1);
});

test("three pastes of image.png become three distinct files", () => {
  let n = 0;
  const ids = () => `0000000${++n}-aaaa-bbbb-cccc-dddddddddddd`;
  const pasted = [1, 2, 3].map(() => namePastedFile(file("image.png", "same", 5, "image/png"), ids));
  const names = pasted.map((f) => f.name);
  assert.equal(new Set(names).size, 3);
  for (const name of names) assert.match(name, /^pasted-image-[0-9a-f]{8}\.png$/);
  // Same content, same lastModified — distinct only because of the new name.
  assert.equal(mergeFiles([], pasted).length, 3);
});

test("a pasted file with a real name keeps it", () => {
  const real = file("Q3 report.pdf");
  assert.equal(namePastedFile(real).name, "Q3 report.pdf");
});

test("a paste carrying text stays a text paste (Office copies an image too)", () => {
  const image = file("image.png", "png", 1, "image/png");
  assert.deepEqual(filesFromPaste(clipboard([image], "A paragraph from Word")), []);
  assert.equal(filesFromPaste(clipboard([image])).length, 1);
  assert.deepEqual(filesFromPaste(clipboard([], "just text")), []);
  assert.deepEqual(filesFromPaste(null), []);
});

test("only drags carrying files are claimed", () => {
  assert.equal(dragHasFiles({ types: ["Files"] } as unknown as DataTransfer), true);
  assert.equal(dragHasFiles({ types: ["text/plain", "text/html"] } as unknown as DataTransfer), false);
  assert.equal(dragHasFiles(null), false);
});

test("adding past the count limit keeps every file and fails the shared verdict", () => {
  const atLimit = Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, i) => file(`f${i}.pdf`, "x", i + 1));
  const merged = mergeFiles(atLimit, [file("one-more.pdf", "x", 999)]);
  assert.equal(merged.length, MAX_ATTACHMENT_COUNT + 1, "nothing is silently discarded");

  const verdict = validateOutgoingAttachments(merged.map((f) => ({ filename: f.name, sizeBytes: f.size })));
  assert.equal(verdict.ok, false);
  // The same sentence the server returns, from the same function.
  assert.match(verdict.ok ? "" : verdict.reason, new RegExp(`up to ${MAX_ATTACHMENT_COUNT} files`));
});
