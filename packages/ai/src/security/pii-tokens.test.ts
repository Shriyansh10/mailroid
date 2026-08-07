/**
 * Tests for reversible sensitive-span tokenisation.
 *
 * The property that actually carries the feature is the last one: tokens must
 * survive the output guard untouched. restore() runs AFTER that guard, so if
 * the guard mangled a token there would be nothing left to substitute and the
 * user's own address would be gone from their own draft — the exact failure
 * this module exists to prevent.
 *
 * Run: pnpm --filter @repo/ai test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { tokenizeSensitiveSpans } from "./pii-tokens.ts";
import { maskPII } from "./pii.ts";
import { sanitizeText, neutralizeContentLinks } from "./sanitizer.ts";

/** The output guard from generate-email.ts, verbatim. */
const guard = (t: string) =>
  neutralizeContentLinks(maskPII(sanitizeText(t, "test").sanitized).masked).sanitized;

test("round-trips text the model returned unchanged", () => {
  const draft = "Hi — reply to sales@acme.com or call +91 98765 43210.";
  const { masked, restore } = tokenizeSensitiveSpans(draft);

  assert.ok(!masked.includes("sales@acme.com"), "address must not reach the model");
  assert.ok(!masked.includes("98765"), "phone must not reach the model");
  assert.equal(restore(masked), draft);
});

test("restores values into text the model edited around", () => {
  const draft = "Please contact sales@acme.com.";
  const { masked, restore } = tokenizeSensitiveSpans(draft);
  const edited = masked.replace("Please contact", "Just reach out to");

  assert.equal(restore(edited), "Just reach out to sales@acme.com.");
});

test("gives one token per distinct value, reused across repeats", () => {
  const draft = "To: alice@x.com\nCc: bob@x.com\nReply to alice@x.com.";
  const { masked, restore, tokenCount } = tokenizeSensitiveSpans(draft);

  assert.equal(tokenCount, 2, "two distinct addresses, three occurrences");
  assert.equal(masked.match(/\[\[EMAIL_1\]\]/g)?.length, 2);
  assert.ok(masked.includes("[[EMAIL_2]]"));
  assert.equal(restore(masked), draft);
});

test("tokenises a link and an email in the same string", () => {
  const draft = "Book at https://cal.acme.com/demo or email sales@acme.com.";
  const { masked, restore, categories } = tokenizeSensitiveSpans(draft);

  assert.ok(categories.includes("LINK"));
  assert.ok(categories.includes("EMAIL"));
  assert.ok(!masked.includes("cal.acme.com"));
  assert.equal(restore(masked), draft);
});

test("leaves a token the model invented alone", () => {
  const { masked, restore } = tokenizeSensitiveSpans("Mail alice@x.com.");
  const hallucinated = masked.replace("[[EMAIL_1]]", "[[EMAIL_7]]");

  assert.equal(
    restore(hallucinated),
    "Mail [[EMAIL_7]].",
    "an unmapped index must stay visibly wrong, never resolve to a neighbour",
  );
});

test("returns identity for text with nothing sensitive", () => {
  const draft = "Thanks for the update — talk soon.";
  const { masked, restore, tokenCount } = tokenizeSensitiveSpans(draft);

  assert.equal(masked, draft);
  assert.equal(tokenCount, 0);
  assert.equal(restore(draft), draft);
});

test("tokens survive the output guard unchanged", () => {
  // The load-bearing property. sanitizeText → maskPII → neutralizeContentLinks
  // must treat a token as ordinary prose, or restore() has nothing to match.
  const draft = [
    "Reach me at sales@acme.com or +91 98765 43210.",
    "Docs: https://acme.com/handbook",
    "Office PIN code 560001, logged from 192.168.1.24.",
  ].join("\n");

  const { masked, restore } = tokenizeSensitiveSpans(draft);
  const guarded = guard(masked);

  assert.equal(guarded, masked, "the guard must not touch tokens");
  assert.equal(restore(guarded), draft, "every original value comes back");
});

test("the guard would destroy the same draft without tokenisation", () => {
  // Pins the reason this module exists: masking straight through loses the
  // user's own contact details. If this ever stops being true, the round-trip
  // is dead weight and should be deleted rather than maintained.
  const draft = "Reach me at sales@acme.com.";

  assert.notEqual(guard(draft), draft);
  assert.ok(guard(draft).includes("[EMAIL]"));
});
