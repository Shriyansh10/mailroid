/**
 * Tests for the cheap attachment indicator derived from a message's top-level
 * Content-Type.
 *
 * This one heuristic decides whether a paperclip appears on an inbox row for
 * mail whose body has never been fetched, so the failure that matters is a
 * FALSE POSITIVE: a paperclip on a message with nothing attached is a claim we
 * cannot back, and it would appear on ordinary mail rather than rarely. The
 * `multipart/related` case is the specific reason this reads the MIME structure
 * instead of Gmail's own `has:attachment` search — that search counts inline
 * signature logos, which a large share of business mail carries.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deriveHasAttachment } from "./sync-metadata.ts";

test("multipart/mixed is the shape that carries a real attachment", () => {
  assert.equal(deriveHasAttachment('multipart/mixed; boundary="000000000000abc"'), true);
  assert.equal(deriveHasAttachment("multipart/mixed"), true);
});

test("an inline signature image does NOT earn a paperclip", () => {
  // multipart/related is html + embedded images. Gmail's has:attachment would
  // match this; that is exactly why it is not what we use.
  assert.equal(
    deriveHasAttachment('multipart/related; boundary="x"'),
    false,
    "a logo in a signature is not an attachment the reader cares about",
  );
});

test("ordinary body shapes are a definite no, not an unknown", () => {
  assert.equal(deriveHasAttachment("text/plain; charset=UTF-8"), false);
  assert.equal(deriveHasAttachment("text/html"), false);
  assert.equal(deriveHasAttachment('multipart/alternative; boundary="y"'), false);
});

test("a missing header is unknown, and unknown never renders", () => {
  // null and false are both non-rendering, but they are not the same claim:
  // false means we looked. Keeping them distinct is what lets the row stay
  // honest when a later hydration overwrites this with the parsed truth.
  assert.equal(deriveHasAttachment(""), null);
  assert.equal(deriveHasAttachment("   "), null);
});

test("case and parameters do not defeat the match", () => {
  assert.equal(deriveHasAttachment("MULTIPART/MIXED; BOUNDARY=Z"), true);
  assert.equal(deriveHasAttachment("  multipart/mixed  ; boundary=z"), true);
});
