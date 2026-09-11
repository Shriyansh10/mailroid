/**
 * The entitlement rules that replaced WHITELISTED_EMAILS.
 *
 * Two of these pin decisions that were argued over and could plausibly be
 * "simplified" back by someone who wasn't in the conversation:
 *
 *   - Lapse is derived from the date, never stored. There is no EXPIRED status,
 *     because a stored flag and a timestamp are two truths that can disagree and
 *     only the timestamp cannot go stale. If someone adds EXPIRED, the test that
 *     a past period is inactive with status still ACTIVE is what should stop them.
 *   - DEVELOPER is not a plan. PLAN_LIMITS must never gain that key, or
 *     "give them PRO" quietly becomes how people get developer authority, and a
 *     lapsed plan quietly removes it.
 *
 * Run: pnpm --filter @repo/services test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  PLAN_LIMITS,
  EXPIRY_WARNING_MS,
  isExpiringSoon,
  isSubscriptionActive,
  limitFor,
} from "./entitlement-policy.ts";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const future = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test("an active subscription with time left is active", () => {
  assert.equal(
    isSubscriptionActive({ status: "ACTIVE", currentPeriodEnd: future(DAY) }, NOW),
    true,
  );
});

test("a period that has passed is inactive even though status still says ACTIVE", () => {
  // The load-bearing one. Nothing writes an EXPIRED status, and nothing needs
  // to: the date alone decides, so a cron that never runs cannot leave someone
  // wrongly paid.
  assert.equal(
    isSubscriptionActive({ status: "ACTIVE", currentPeriodEnd: future(-1) }, NOW),
    false,
  );
});

test("the exact instant of expiry is already lapsed", () => {
  assert.equal(
    isSubscriptionActive({ status: "ACTIVE", currentPeriodEnd: NOW }, NOW),
    false,
  );
});

test("cancelling revokes immediately, it does not run to the end of the period", () => {
  assert.equal(
    isSubscriptionActive({ status: "CANCELLED", currentPeriodEnd: future(30 * DAY) }, NOW),
    false,
  );
});

test("no subscription row at all is inactive — absence is how FREE is stored", () => {
  assert.equal(isSubscriptionActive(undefined, NOW), false);
  assert.equal(isSubscriptionActive(null, NOW), false);
});

test("the expiry warning covers the final day and nothing earlier", () => {
  assert.equal(isExpiringSoon(future(EXPIRY_WARNING_MS - HOUR), NOW), true);
  assert.equal(isExpiringSoon(future(EXPIRY_WARNING_MS + HOUR), NOW), false);
  // FREE has no expiry, so it can never be expiring.
  assert.equal(isExpiringSoon(null, NOW), false);
});

test("the feedback unlock raises FREE and leaves paid plans alone", () => {
  assert.equal(limitFor("FREE", false), 10);
  assert.equal(limitFor("FREE", true), 20);
  // A paying user should never have to file feedback to get what they paid for.
  assert.equal(limitFor("PRO", false), limitFor("PRO", true));
  assert.equal(limitFor("ULTIMATE", false), limitFor("ULTIMATE", true));
});

test("paid plans are strictly more generous than free", () => {
  assert.ok(limitFor("PRO", false) > limitFor("FREE", true));
  assert.ok(limitFor("ULTIMATE", false) > limitFor("PRO", true));
});

test("DEVELOPER is not a plan and must never become one", () => {
  assert.deepEqual(Object.keys(PLAN_LIMITS).sort(), ["FREE", "PRO", "ULTIMATE"]);
  assert.equal("DEVELOPER" in PLAN_LIMITS, false);
});
