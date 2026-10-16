/**
 * The response target and the judgements built on it.
 *
 * Every assertion here guards something that fails silently: a boundary off by
 * one second, a green badge on an empty mailbox, a policy whose stale threshold
 * is shorter than its target. None of these make a page throw — they make it
 * render a number that is wrong and completely believable.
 *
 * Run: pnpm --filter @repo/services test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { INBOUND_VOLUME } from "./metrics-policy.ts";
import * as slaPolicy from "./sla-policy.ts";
import {
  FIRST_RESPONSE_TARGET_SECONDS,
  MAILROID_DEFAULT_SLA_POLICY,
  RESPONDABLE_CLASS,
  STALE_AFTER_SECONDS,
  adherenceStatus,
  assertValidPolicy,
  isOverdue,
  isStale,
  isWithinTarget,
  trafficClassById,
  withinTargetNeeded,
  type SlaPolicy,
  type SlaTarget,
} from "./sla-policy.ts";

const target: SlaTarget = {
  firstResponseSeconds: FIRST_RESPONSE_TARGET_SECONDS,
  staleAfterSeconds: STALE_AFTER_SECONDS,
};

const policyWith = (overrides: Partial<SlaTarget>): SlaPolicy => ({
  classes: [{ ...RESPONDABLE_CLASS, target: { ...target, ...overrides } }],
});

test("a reply landing exactly on the target is within it", () => {
  // `<` rather than `<=` marks a reply at 4:00:00.000 as late. Nobody would
  // ever notice from the dashboard; the person whose thread it was would.
  assert.equal(isWithinTarget(FIRST_RESPONSE_TARGET_SECONDS, target), true);
  assert.equal(isWithinTarget(FIRST_RESPONSE_TARGET_SECONDS + 1, target), false);
  assert.equal(isOverdue(FIRST_RESPONSE_TARGET_SECONDS, target), false);
  assert.equal(isOverdue(FIRST_RESPONSE_TARGET_SECONDS + 1, target), true);
  assert.equal(isStale(STALE_AFTER_SECONDS, target), false);
  assert.equal(isStale(STALE_AFTER_SECONDS + 1, target), true);
});

test("a person who received no answerable mail is unmeasured, not perfect", () => {
  // The vacuously-perfect bug: zero threads, zero misses, 100% adherence, green
  // badge on an empty mailbox.
  const result = adherenceStatus({
    threadsRespondable: 0,
    threadsAnsweredWithinTarget: 0,
    target,
  });
  assert.equal(result.status, "NO_DATA");
  assert.notEqual(result.status, "ON_TARGET");
  assert.ok(result.reason.length > 0);
});

test("every status explains itself with both numbers", () => {
  // A status a person cannot question is a status nobody trusts. "Off target"
  // on its own invites the question this string has to already answer.
  const cases = [
    { threadsRespondable: 15, threadsAnsweredWithinTarget: 15 },
    { threadsRespondable: 15, threadsAnsweredWithinTarget: 12 },
    { threadsRespondable: 15, threadsAnsweredWithinTarget: 2 },
  ];
  for (const sample of cases) {
    const { reason } = adherenceStatus({ ...sample, target });
    assert.ok(reason.includes(String(sample.threadsAnsweredWithinTarget)), reason);
    assert.ok(reason.includes(String(sample.threadsRespondable)), reason);
    assert.ok(reason.includes("4h"), reason);
  }
});

test("the adherence vocabulary is closed at four states", () => {
  // Excellent / Good / Average / Poor is an ordinal rating wearing adjectives,
  // and would reintroduce by the back door the composite score this feature
  // deliberately does not have.
  const allowed = new Set(["NO_DATA", "ON_TARGET", "SLIPPING", "OFF_TARGET"]);
  for (let withinTarget = 0; withinTarget <= 20; withinTarget++) {
    const { status } = adherenceStatus({
      threadsRespondable: 20,
      threadsAnsweredWithinTarget: withinTarget,
      target,
    });
    assert.ok(allowed.has(status), `unexpected status ${status}`);
  }
  // NOT_COVERED is a coverage state and must not leak into adherence, or the
  // SLA module ends up needing account data it was built not to have.
  assert.equal(allowed.has("NOT_COVERED"), false);
});

test("stale is always a superset of overdue, by construction", () => {
  // Asserted on the shipped constants, not on a fixture: if these ever cross,
  // a person can show more stale threads than overdue ones, which is
  // unreadable and true of no thread that has ever existed.
  assert.ok(STALE_AFTER_SECONDS >= FIRST_RESPONSE_TARGET_SECONDS);
});

test("an unknown traffic class is null, never the default one", () => {
  // Falling back would measure the wrong mail with a right-looking number.
  assert.equal(trafficClassById(MAILROID_DEFAULT_SLA_POLICY, "CUSTOMER"), null);
  assert.equal(trafficClassById(MAILROID_DEFAULT_SLA_POLICY, "RESPONDABLE"), RESPONDABLE_CLASS);
});

test("a traffic class only ever contains mail that was counted as received", () => {
  // A class containing SENT would count a person's own mail as something they
  // owe a reply to.
  for (const klass of MAILROID_DEFAULT_SLA_POLICY.classes) {
    for (const category of klass.categories) {
      assert.ok(INBOUND_VOLUME.includes(category), `${category} is not inbound`);
    }
    assert.equal(klass.categories.includes("SENT"), false);
  }
});

test("a malformed policy is refused before any metric can consume it", () => {
  assertValidPolicy(MAILROID_DEFAULT_SLA_POLICY);

  const rejected: Array<[string, SlaPolicy]> = [
    ["zero target", policyWith({ firstResponseSeconds: 0 })],
    ["negative target", policyWith({ firstResponseSeconds: -60 })],
    ["NaN target", policyWith({ firstResponseSeconds: Number.NaN })],
    ["infinite target", policyWith({ firstResponseSeconds: Number.POSITIVE_INFINITY })],
    ["fractional target", policyWith({ firstResponseSeconds: 60.5 })],
    ["zero stale threshold", policyWith({ staleAfterSeconds: 0 })],
    ["stale before overdue", policyWith({ staleAfterSeconds: 60 })],
    ["no categories", { classes: [{ ...RESPONDABLE_CLASS, categories: [] }] }],
    ["no classes", { classes: [] }],
    ["duplicate class", { classes: [RESPONDABLE_CLASS, RESPONDABLE_CLASS] }],
  ];

  for (const [name, policy] of rejected) {
    assert.throws(() => assertValidPolicy(policy), `${name} should have been refused`);
  }
});

test("this module exports no score, rating, rank or grade", () => {
  // Stated three times in the codebase and enforced once here. The forbidden
  // thing is a single number summarising a person; counts and durations are
  // exactly what this feature reports.
  for (const name of Object.keys(slaPolicy)) {
    assert.doesNotMatch(name, /score|rating|rank|grade/i, `${name} is a ranking concept`);
  }
});

test("the goal gap agrees with the badge exactly at the boundary", () => {
  const gap = (within: number, respondable: number) =>
    withinTargetNeeded({ threadsRespondable: respondable, threadsAnsweredWithinTarget: within, target });

  // 0.9 * 70 is 63.00000000000001 in floating point, so ceil() says 64. The
  // badge says 63 of 70 is on target; the gap must say the same.
  assert.equal(
    adherenceStatus({ threadsRespondable: 70, threadsAnsweredWithinTarget: 63, target }).status,
    "ON_TARGET",
  );
  assert.equal(gap(63, 70), null);
  assert.equal(gap(62, 70), 1);
  assert.equal(gap(9, 10), null);
  assert.equal(gap(8, 10), 1);
  assert.equal(gap(74, 100), 16);
  // Crossing the SLIPPING boundary does not move the ON_TARGET gap.
  assert.equal(gap(75, 100), 15);
  assert.equal(gap(0, 3), 3);
});

test("no gap is reported for an empty cohort or one already on target", () => {
  assert.equal(withinTargetNeeded({ threadsRespondable: 0, threadsAnsweredWithinTarget: 0, target }), null);
  assert.equal(withinTargetNeeded({ threadsRespondable: 12, threadsAnsweredWithinTarget: 12, target }), null);
});

test("the goal gap is minimal, and bounded by the threads not answered within target", () => {
  for (let respondable = 1; respondable <= 300; respondable++) {
    for (let within = 0; within <= respondable; within++) {
      const n = withinTargetNeeded({ threadsRespondable: respondable, threadsAnsweredWithinTarget: within, target });
      const statusAt = (w: number) =>
        adherenceStatus({ threadsRespondable: respondable, threadsAnsweredWithinTarget: w, target }).status;
      if (n === null) {
        assert.equal(statusAt(within), "ON_TARGET", `${within}/${respondable} has no gap but is not on target`);
        continue;
      }
      assert.ok(n >= 1);
      // Late answers can never become within-target, so the bound is
      // respondable - within, not the count of threads still unanswered.
      assert.ok(n <= respondable - within, `${within}/${respondable}: gap ${n} exceeds what is possible`);
      assert.equal(statusAt(within + n), "ON_TARGET", `${within}/${respondable} + ${n}`);
      assert.notEqual(statusAt(within + n - 1), "ON_TARGET", `${within}/${respondable}: ${n} is not minimal`);
    }
  }
});
