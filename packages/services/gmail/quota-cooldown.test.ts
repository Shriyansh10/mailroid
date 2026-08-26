/**
 * Tests for Gmail quota-cooldown classification and retry-window parsing.
 *
 * These two functions decide whether a mailbox stops calling Google. Get
 * `isQuotaError` wrong and no cooldown is recorded, so retries keep pushing
 * Google's window forward and the mailbox never recovers — the exact
 * seven-hour production outage this module was written for. Get
 * `extractRetryAfter` wrong and the window is merely imprecise, which is why
 * the fragile string handling lives there and nothing else depends on it.
 *
 * Pure functions only: no DB, no network.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultCooldownUntil,
  escalatedCooldownUntil,
} from "./quota-cooldown.ts";
// Imported from the gate-free module directly: these are pure, and reaching
// them through quota-cooldown.ts would drag in the database client for no
// reason. quota-cooldown.ts re-exports them for production callers.
import {
  classifyGmailFailure,
  extractRetryAfter,
  isGmailUnavailable,
  isQuotaError,
} from "./gmail-errors.ts";

/** The real corsair ApiError shape, copied from production logs. */
function apiError(retryAfterIso?: string) {
  return {
    name: "ApiError",
    message: "Too Many Requests",
    status: 429,
    statusText: "Too Many Requests",
    body: {
      error: {
        code: 429,
        message: retryAfterIso
          ? `User-rate limit exceeded.  Retry after ${retryAfterIso}`
          : "User-rate limit exceeded.",
        status: "RESOURCE_EXHAUSTED",
      },
    },
  };
}

// ---------------------------------------------------------------- detection

test("structured 429 status is a quota error", () => {
  assert.equal(isQuotaError(apiError()), true);
});

test("RESOURCE_EXHAUSTED body status is a quota error even without a numeric status", () => {
  assert.equal(isQuotaError({ body: { error: { status: "RESOURCE_EXHAUSTED" } } }), true);
});

test("the plain-Error string form from the raw history fetch is still detected", () => {
  // webhook-sync.ts historically flattened the status into prose. This is the
  // exact path the production deadlock ran through — missing it means never
  // cooling down.
  const err = new Error('Gmail history fetch failed: 429 - {"error":{"code":429}}');
  assert.equal(isQuotaError(err), true);
});

test("non-quota errors are not misclassified", () => {
  assert.equal(isQuotaError({ status: 404, message: "Not Found" }), false);
  assert.equal(isQuotaError({ status: 500, message: "Internal Error" }), false);
  assert.equal(isQuotaError(new Error("socket hang up")), false);
});

test("unavailability covers quota, 5xx and transport but never auth or missing", () => {
  assert.equal(isGmailUnavailable(apiError()), true);
  assert.equal(isGmailUnavailable({ status: 503 }), true);
  assert.equal(isGmailUnavailable(new Error("ECONNRESET")), true, "no status = never reached Google");

  // A revoked token or deleted thread is real and actionable — serving a stale
  // cached copy instead would hide precisely the drift the user must be told about.
  assert.equal(isGmailUnavailable({ status: 401 }), false);
  assert.equal(isGmailUnavailable({ status: 403 }), false);
  assert.equal(isGmailUnavailable({ status: 404 }), false);
});

// ------------------------------------------------------------------ parsing

const NOW = new Date("2026-08-04T03:58:00.000Z");

test("a well-formed ISO instant is extracted and padded for clock skew", () => {
  const got = extractRetryAfter(apiError("2026-08-04T03:58:23.313Z"), NOW);
  assert.ok(got);
  assert.equal(got.toISOString(), "2026-08-04T03:58:28.313Z"); // +5s pad
});

test("an instant already in the past is treated as unparseable", () => {
  // Cooling down until a moment that has already passed is worse than useless:
  // it reads as an active window while permitting the call immediately.
  assert.equal(extractRetryAfter(apiError("2026-08-04T03:00:00.000Z"), NOW), null);
});

test("an absurd future instant is clamped to the 60 minute ceiling", () => {
  const got = extractRetryAfter(apiError("3000-01-01T00:00:00.000Z"), NOW);
  assert.ok(got);
  assert.equal(got.toISOString(), "2026-08-04T04:58:00.000Z");
});

test("a 429 with no timestamp yields null so the caller applies its default", () => {
  assert.equal(extractRetryAfter(apiError(), NOW), null);
});

test("an error with no body at all yields null rather than throwing", () => {
  assert.equal(extractRetryAfter(new Error("boom"), NOW), null);
  assert.equal(extractRetryAfter(null, NOW), null);
  assert.equal(extractRetryAfter(undefined, NOW), null);
});

test("a numeric Retry-After header is honoured when no instant is present", () => {
  const err = {
    status: 429,
    message: "Too Many Requests",
    headers: { get: (n: string) => (n === "retry-after" ? "120" : null) },
  };
  const got = extractRetryAfter(err, NOW);
  assert.ok(got);
  assert.equal(got.toISOString(), "2026-08-04T04:00:05.000Z"); // +120s, +5s pad
});

test("reworded messages degrade to null, never to a wrong instant", () => {
  // The wording is Google's, not a contract. If it changes we lose precision
  // and fall back to the default window — detection and safety are unaffected.
  const reworded = {
    status: 429,
    body: { error: { message: "Quota exceeded. Please try again later." } },
  };
  assert.equal(isQuotaError(reworded), true, "still detected");
  assert.equal(extractRetryAfter(reworded, NOW), null, "only precision is lost");
});

test("an unusual wording around a valid instant is still parsed", () => {
  const variant = {
    status: 429,
    body: { error: { message: "Please retry after 2026-08-04T04:10:00Z to continue" } },
  };
  const got = extractRetryAfter(variant, NOW);
  assert.ok(got);
  assert.equal(got.toISOString(), "2026-08-04T04:10:05.000Z");
});

test("the default window is five minutes out", () => {
  assert.equal(defaultCooldownUntil(NOW).toISOString(), "2026-08-04T04:03:00.000Z");
});

// -------------------------------------------------------------- escalation
//
// Why this exists: trusting each fresh 429's Retry-After independently means
// that when Google's real block outlasts a single window, every resume
// attempt lands on the boundary, gets refused, and believes the NEXT window —
// forever. Seen in prod as one renewal roughly every 15 minutes for over an
// hour on one mailbox. escalatedCooldownUntil widens the window on each
// consecutive failed resumption so the probe interval stops being one already
// proven insufficient.
//
// NOTE: the "reset to 0 on the first Gmail success" invariant is enforced by
// markGmailHealthy (packages/services/gmail/quota-cooldown.ts), which is
// DB-backed — this suite is pure-functions-only (see file docblock), so that
// half of the invariant is not exercised here. What IS verified below is the
// half escalatedCooldownUntil is actually responsible for: that it never
// carries any state of its own — passing failures=0 always reproduces
// Google's raw window, regardless of how many failures preceded it. Correct
// behavior of the whole invariant depends on the DB layer actually passing 0
// after a reset, which this function has no way to get wrong.

const GOOGLE_15_MIN = new Date(NOW.getTime() + 15 * 60_000);

test("zero consecutive failures returns Google's instant verbatim", () => {
  assert.equal(escalatedCooldownUntil(GOOGLE_15_MIN, 0, NOW).toISOString(), GOOGLE_15_MIN.toISOString());
});

test("the escalation ladder doubles per consecutive failure: 15 -> 30 -> 60", () => {
  assert.equal(
    escalatedCooldownUntil(GOOGLE_15_MIN, 1, NOW).toISOString(),
    "2026-08-04T04:28:00.000Z", // 30 min out
  );
  assert.equal(
    escalatedCooldownUntil(GOOGLE_15_MIN, 2, NOW).toISOString(),
    "2026-08-04T04:58:00.000Z", // 60 min out — clamp already binding here (15*4=60)
  );
});

test("the ladder holds at the 60 minute ceiling for any higher failure count", () => {
  const at3 = escalatedCooldownUntil(GOOGLE_15_MIN, 3, NOW);
  const at10 = escalatedCooldownUntil(GOOGLE_15_MIN, 10, NOW);
  assert.equal(at3.toISOString(), "2026-08-04T04:58:00.000Z");
  assert.equal(at10.toISOString(), "2026-08-04T04:58:00.000Z", "must never exceed MAX_COOLDOWN_MS regardless of failure count");
});

test("a Google instant longer than the escalated floor still wins — never accidentally shortened", () => {
  // failures=0 means the escalated floor equals Google's own window exactly,
  // so this also guards against a future refactor collapsing the max() into
  // something that could shrink a legitimate, conservative Google answer.
  const google50min = new Date(NOW.getTime() + 50 * 60_000);
  assert.equal(escalatedCooldownUntil(google50min, 0, NOW).toISOString(), google50min.toISOString());
});

test("a Google instant in the past yields a zero-length base window rather than throwing", () => {
  const pastInstant = new Date(NOW.getTime() - 60_000);
  assert.equal(escalatedCooldownUntil(pastInstant, 0, NOW).toISOString(), NOW.toISOString());
});

// ----------------------------------------------------------- classification
//
// The 2026-08-25 incident in one sentence: a 401 was handed to the quota
// ladder, producing a cooldown that blocked the token refresh which would have
// cleared the 401. These tests pin the boundary that makes that impossible.

/** The exact 401 body Google returned during the incident. */
const AUTH_401 = {
  status: 401,
  body: {
    error: {
      code: 401,
      message:
        "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
      status: "UNAUTHENTICATED",
    },
  },
};

test("a 429 is quota, not auth", () => {
  assert.equal(classifyGmailFailure(apiError()), "quota");
  assert.equal(classifyGmailFailure(apiError("2026-08-26T02:16:00.539Z")), "quota");
});

test("the production 401 is auth, never quota", () => {
  // If this ever returns "quota" the deadlock is back.
  assert.equal(classifyGmailFailure(AUTH_401), "auth");
});

test("a BARE 403 is other, not auth", () => {
  // Google returns 403 for insufficient scopes, a disabled API and project
  // policy. None are fixed by refreshing a token, and marking the mailbox
  // auth-dead would take it offline for the wrong reason and hide the real
  // misconfiguration.
  assert.equal(classifyGmailFailure({ status: 403, message: "Forbidden" }), "other");
  assert.equal(
    classifyGmailFailure({
      status: 403,
      body: { error: { code: 403, message: "Gmail API has not been used in project 123" } },
    }),
    "other",
  );
});

test("a 403 carrying an OAuth invalidity marker is auth", () => {
  assert.equal(
    classifyGmailFailure({
      status: 403,
      body: { error: { code: 403, message: "invalid_grant: Token has been expired or revoked." } },
    }),
    "auth",
  );
});

test("corsair's own auth failures are auth despite carrying no 401 status", () => {
  // A genuinely revoked refresh token never reaches us as an HTTP status: the
  // Gmail keyBuilder throws before any request is issued. Classifying on
  // status alone would drop the single case the auth-failed state exists for
  // into "other", and the mailbox would go quiet with nothing recorded.
  assert.equal(
    classifyGmailFailure(
      new Error(
        "[corsair:gmail] Failed to obtain valid access token: Failed to refresh access token: invalid_grant",
      ),
    ),
    "auth",
  );
  assert.equal(
    classifyGmailFailure(
      new Error("[auth-missing:gmail:client_credentials]: Gmail client credentials are missing"),
    ),
    "auth",
  );
  assert.equal(
    classifyGmailFailure(Object.assign(new Error("gmail oauth_2"), { name: "AuthMissingError" })),
    "auth",
  );
});

test("ordinary failures are other, so nothing is written for them", () => {
  assert.equal(classifyGmailFailure({ status: 500 }), "other");
  assert.equal(classifyGmailFailure({ status: 404 }), "other");
  assert.equal(classifyGmailFailure(new Error("socket hang up")), "other");
  assert.equal(classifyGmailFailure(null), "other");
});

test("a 429 that also mentions credentials still classifies as quota", () => {
  // Quota is checked first on purpose: a mailbox Google is refusing must back
  // off, and marking it auth-dead instead would stop the backoff entirely.
  assert.equal(
    classifyGmailFailure({
      status: 429,
      body: { error: { code: 429, message: "User-rate limit exceeded. invalid credentials" } },
    }),
    "quota",
  );
});
