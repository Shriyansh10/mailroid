/**
 * Tests for the Gmail failure classifier, focused on one specific hazard.
 *
 * THE FAILURE MODE BEING EXCLUDED. `isQuotaError` falls back to matching strings
 * like /429|rate limit|RESOURCE_EXHAUSTED/i against an error's message, because
 * corsair sometimes surfaces a quota refusal with no usable status code. That
 * fallback is correct and load-bearing — and it means any error phrased like
 * Google's gets treated as a quota failure.
 *
 * `GmailPacedOutError` is raised by OUR OWN limiter, before any request is sent.
 * If it were classified as `quota`, `handleGmailFailure` would open a real
 * 15 -> 30 -> 60-minute cooldown on a completely healthy mailbox, and the
 * symptom would be indistinguishable from the 2026-08-25 incident: a mailbox
 * stuck in escalating cooldown for a quota penalty that never happened.
 *
 * There are two defences and both are tested: an explicit instanceof check, and
 * the wording of the message itself.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GmailAuthError,
  GmailPacedOutError,
  classifyGmailFailure,
  isGmailUnavailable,
} from "./gmail-errors.ts";

function pacedOut(): GmailPacedOutError {
  return new GmailPacedOutError({
    tenantId: "tenant-a",
    operation: "threads.get",
    trigger: "ui",
    waitMs: 5_000,
    capMs: 2_000,
  });
}

test("our own pacing refusal is not a Gmail failure of any kind", () => {
  // "other" is the answer that means: no cooldown row, no auth-dead marking.
  assert.equal(classifyGmailFailure(pacedOut()), "other");
});

test("the pacing message is safe even stripped of its type", () => {
  // THE REAL GUARD. The instanceof check protects the object; this protects the
  // WORDING. An error crossing a serialisation boundary, wrapped by a library,
  // or reconstructed from a log arrives as a plain Error carrying only the
  // message — and it must still not read as a quota failure.
  const plain = new Error(pacedOut().message);
  assert.equal(classifyGmailFailure(plain), "other");

  // Spelled out, so a future edit to the message has to fail this deliberately
  // rather than by accident.
  const text = pacedOut().message.toLowerCase();
  for (const forbidden of ["429", "rate limit", "user-rate", "resource_exhausted"]) {
    assert.ok(!text.includes(forbidden), `pacing message must not contain "${forbidden}"`);
  }
});

test("a real quota error still classifies as quota", () => {
  // The guard above must not have blunted the thing it guards.
  const real = new Error("User-rate limit exceeded.  Retry after 2026-08-26T07:02:47.506Z");
  assert.equal(classifyGmailFailure(real), "quota");
});

test("an auth failure is still auth", () => {
  assert.equal(classifyGmailFailure(new GmailAuthError("tenant-a", "no token", 401)), "auth");
});

test("paced out reads as unavailable, so cached reads degrade instead of failing", () => {
  // This single line is what makes every existing cache-fallback path handle
  // pacing with no call-site change: "cannot reach Gmail right now, the stored
  // copy is the best answer" is exactly true of a paced-out call.
  assert.equal(isGmailUnavailable(pacedOut()), true);
});

test("unavailability still excludes the errors a user needs told about", () => {
  // A revoked token or a deleted thread must NOT be papered over with stale
  // content — the drift has to surface. Adding pacing must not have widened
  // this.
  assert.equal(isGmailUnavailable(new GmailAuthError("tenant-a", "revoked", 401)), false);
  assert.equal(isGmailUnavailable({ status: 404 }), false);
  assert.equal(isGmailUnavailable({ status: 403 }), false);
  assert.equal(isGmailUnavailable({ status: 503 }), true);
});

test("the error carries what an operator needs to act on it", () => {
  const err = pacedOut();
  assert.equal(err.name, "GmailPacedOutError");
  assert.equal(err.tenantId, "tenant-a");
  assert.equal(err.operation, "threads.get");
  assert.equal(err.trigger, "ui");
  assert.equal(err.waitMs, 5_000);
  assert.equal(err.capMs, 2_000);
});
