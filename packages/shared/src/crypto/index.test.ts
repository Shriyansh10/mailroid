/**
 * The contract the encryption swap must not break.
 *
 * `sealField` is a pass-through today, so most of these assertions look trivial. They are
 * not: they are the invariants the real AES-256-GCM implementation has to keep when it
 * replaces the body of that module. If a future change makes one of these fail, the swap
 * has altered behaviour that call sites already depend on.
 *
 * The two that matter most are the ones that are NOT identity: an unrecognised seal must
 * throw rather than hand back ciphertext as if it were readable text, and an incomplete
 * FieldContext must throw rather than silently produce a value whose AAD cannot bind it
 * to its row. Both are the difference between a failure you see and one you ship.
 *
 * Run: pnpm --filter @repo/shared test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTENT_ENCRYPTION_ENABLED,
  type FieldContext,
  isSealed,
  openField,
  sealField,
} from "./index.ts";

const ctx: FieldContext = {
  userId: "user_123",
  table: "emails",
  rowId: "9f1c0d2e-0000-4000-8000-000000000001",
  column: "body_text",
};

test("a sealed value opens back to the original", () => {
  const plaintext = "The deployment is delayed. I need another day.";
  assert.equal(openField(sealField(plaintext, ctx), ctx), plaintext);
});

test("null survives both directions", () => {
  assert.equal(sealField(null, ctx), null);
  assert.equal(openField(null, ctx), null);
});

test("legacy plaintext rows read back unchanged", () => {
  assert.equal(openField("written before encryption existed", ctx), "written before encryption existed");
});

test("an unrecognised seal version throws instead of returning ciphertext", () => {
  assert.throws(
    () => openField("mrenc:v9:AAAAAAAA", ctx),
    /sealed with version "v9"/,
  );
});

test("an incomplete context throws — AAD cannot bind without all four fields", () => {
  const incomplete = { ...ctx, rowId: "" };
  assert.throws(() => sealField("x", incomplete), /incomplete FieldContext/);
  assert.throws(() => openField("x", incomplete), /incomplete FieldContext/);
});

test("isSealed reports false for everything stored today", () => {
  assert.equal(isSealed("plain body"), false);
  assert.equal(isSealed(null), false);
  assert.equal(isSealed("mrenc:v1:AAAA"), true);
});

test("the enabled flag is still false", () => {
  // Flipping this to true is the signal to revisit every assertion above.
  assert.equal(CONTENT_ENCRYPTION_ENABLED, false);
});
