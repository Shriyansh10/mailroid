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
  isPermissionDenied,
  isQuotaError,
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
  for (const forbidden of ["429", "rate limit", "user-rate", "resource_exhausted", "quota exceeded"]) {
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

// ── quota 403s and genuine permission 403s ──────────────────────────

/**
 * The exact body Google returned to prod at 2026-10-01T14:52:51Z (webhook
 * history.list for mailbox 008). Captured from the api log, not hand-written.
 */
const PROD_QUOTA_403_BODY = {
  error: {
    code: 403,
    message:
      "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:347863351495'.",
    errors: [
      {
        message:
          "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:347863351495'.",
        domain: "usageLimits",
        reason: "rateLimitExceeded",
      },
    ],
    status: "PERMISSION_DENIED",
  },
};

/** The shape corsair's request layer throws: message "Forbidden", body parsed. */
function corsairApiError(status: number, body: unknown) {
  return Object.assign(new Error(status === 403 ? "Forbidden" : "Error"), {
    name: "ApiError",
    status,
    statusText: "Forbidden",
    body,
  });
}

const reasonBody = (reason: string, domain = "global") => ({
  error: { code: 403, message: "x", errors: [{ reason, domain, message: "x" }], status: "PERMISSION_DENIED" },
});

test("the production quota 403, as corsair throws it, is a quota error", () => {
  // The bug this fixes: message "Forbidden", status 403, PERMISSION_DENIED —
  // every previous check missed it, so initial sync skipped the thread.
  const err = corsairApiError(403, PROD_QUOTA_403_BODY);
  assert.equal(isQuotaError(err), true);
  assert.equal(classifyGmailFailure(err), "quota");
  assert.equal(isPermissionDenied(err), false);
});

test("the production quota 403, as the raw history fetch throws it, is a quota error", () => {
  const text = JSON.stringify(PROD_QUOTA_403_BODY);
  const err = Object.assign(new Error(`Gmail history fetch failed: 403 - ${text}`), {
    status: 403,
    body: PROD_QUOTA_403_BODY,
  });
  assert.equal(classifyGmailFailure(err), "quota");
});

test("every Google quota reason reads as quota, inside corsair's error shape", () => {
  for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"]) {
    const err = corsairApiError(403, reasonBody(reason));
    assert.equal(classifyGmailFailure(err), "quota", reason);
    assert.equal(isPermissionDenied(err), false, reason);
  }
});

test("a body that arrives as a JSON string is read the same way", () => {
  assert.equal(isQuotaError(corsairApiError(403, JSON.stringify(PROD_QUOTA_403_BODY))), true);
});

test("a genuine permission 403 is denied, never quota", () => {
  for (const reason of ["forbidden", "insufficientPermissions", "domainPolicy"]) {
    const err = corsairApiError(403, reasonBody(reason));
    assert.equal(isQuotaError(err), false, reason);
    assert.equal(isPermissionDenied(err), true, reason);
    assert.equal(classifyGmailFailure(err), "other", reason);
  }
});

test("a 403 with no readable detail is neither quota nor confirmed denied", () => {
  // Could be a quota refusal whose body was lost. Declaring it permanent on
  // first sight would drop the data; calling it quota would invent a cooldown.
  for (const body of [undefined, "", "not json", { error: {} }, { error: { errors: "x" } }]) {
    const err = corsairApiError(403, body);
    assert.equal(isQuotaError(err), false, JSON.stringify(body));
    assert.equal(isPermissionDenied(err), false, JSON.stringify(body));
  }
});

test("a 429 is still quota, and a quota 403 now counts as Gmail being unavailable", () => {
  assert.equal(classifyGmailFailure(corsairApiError(429, undefined)), "quota");
  // So cached reads degrade during a quota 403 instead of failing outright.
  assert.equal(isGmailUnavailable(corsairApiError(403, PROD_QUOTA_403_BODY)), true);
  assert.equal(isGmailUnavailable(corsairApiError(403, reasonBody("forbidden"))), false);
});
