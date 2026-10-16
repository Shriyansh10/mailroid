/**
 * What gets flagged, what does not, and what the flags are allowed to say.
 *
 * The failures guarded here are all of the same shape: a flag that fires when
 * nothing is wrong, or a number inferred from the absence of data. Both make a
 * healthy person look like a problem, and neither throws.
 *
 * Run: pnpm --filter @repo/services test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { exceptionsFor, recommendationsFor, type ExceptionKind } from "./exceptions-policy.ts";
import { MAILROID_DEFAULT_SLA_POLICY } from "./sla-policy.ts";
import type { MemberMetrics } from "./types.ts";

const policy = MAILROID_DEFAULT_SLA_POLICY;

const row = (overrides: Partial<MemberMetrics> = {}): MemberMetrics => ({
  email: "person@example.com",
  received: 40,
  sent: 38,
  medianResponseSeconds: 900,
  threadsRespondable: 15,
  threadsAnswered: 15,
  threadsAnsweredWithinTarget: 15,
  threadsAwaitingReply: 0,
  threadsOverdue: 0,
  threadsStale: 0,
  oldestWaitingSeconds: null,
  ...overrides,
});

const kindsOf = (metrics: MemberMetrics): ExceptionKind[] =>
  exceptionsFor({ metrics, coverage: "COVERED" }, policy).map((flag) => flag.kind);

test("a healthy row raises nothing at all", () => {
  assert.deepEqual(kindsOf(row()), []);
  assert.deepEqual(recommendationsFor([]), []);
});

test("one thread waiting two hours is not an exception", () => {
  // Everybody with a waiting thread has an oldest one. A flag that fires on
  // every healthy row gets ignored, and takes the genuine flags with it — which
  // is why OLDEST_WAITING is a metric and not a kind.
  const metrics = row({ threadsAwaitingReply: 1, oldestWaitingSeconds: 2 * 60 * 60 });
  assert.deepEqual(kindsOf(metrics), []);
});

test("a three-day unanswered thread raises three different facts at once", () => {
  // Not double-counting: one says nobody replied, one says it passed the
  // target, one says it has fallen off the radar. Nested populations, shown as
  // such, never summed.
  const kinds = kindsOf(
    row({
      threadsRespondable: 15,
      threadsAnswered: 14,
      threadsAnsweredWithinTarget: 14,
      threadsAwaitingReply: 1,
      threadsOverdue: 1,
      threadsStale: 1,
      oldestWaitingSeconds: 3 * 24 * 60 * 60,
    }),
  );
  assert.deepEqual(kinds, ["STALE_WAITING", "OVERDUE_WAITING", "UNANSWERED"]);
});

test("waiting past the target is ACT; a large backlog is only INFO", () => {
  // Ten open threads is a fact about load. Three threads past the target is
  // something a person can go and clear today. Ranking them the same way makes
  // the urgent one invisible.
  const flags = exceptionsFor(
    {
      metrics: row({
        threadsAwaitingReply: 12,
        threadsOverdue: 3,
        threadsAnswered: 15,
        threadsAnsweredWithinTarget: 15,
      }),
      coverage: "COVERED",
    },
    policy,
  );
  const severityOf = (kind: ExceptionKind) => flags.find((f) => f.kind === kind)?.severity;
  assert.equal(severityOf("OVERDUE_WAITING"), "ACT");
  assert.equal(severityOf("PENDING_BACKLOG"), "INFO");
});

test("the backlog flag fires at the threshold, not past it", () => {
  assert.equal(kindsOf(row({ threadsAwaitingReply: 9 })).includes("PENDING_BACKLOG"), false);
  assert.equal(kindsOf(row({ threadsAwaitingReply: 10 })).includes("PENDING_BACKLOG"), true);
});

test("somebody we cannot measure gets exactly one flag, and no performance ones", () => {
  // Inferring "answered nothing" from "we cannot see anything" is the failure
  // the coverage concept exists to prevent.
  for (const coverage of ["NO_ACCOUNT", "NO_GMAIL", "GMAIL_ERROR", "MAILBOX_MISMATCH"] as const) {
    const flags = exceptionsFor({ metrics: null, coverage }, policy);
    assert.deepEqual(
      flags.map((f) => f.kind),
      ["NOT_COVERED"],
    );
    assert.equal(flags[0]?.severity, "INFO");
  }
});

test("a person with no mail at all is absent, not underperforming", () => {
  const flags = exceptionsFor(
    {
      metrics: row({
        received: 0,
        sent: 0,
        medianResponseSeconds: null,
        threadsRespondable: 0,
        threadsAnswered: 0,
        threadsAnsweredWithinTarget: 0,
      }),
      coverage: "COVERED",
    },
    policy,
  );
  assert.deepEqual(flags, []);
});

test("the same row twice produces byte-identical output", () => {
  // Guards against a Set or an Object.keys walk leaking into the ordering,
  // which makes a correct list look like a bug on every other render.
  const metrics = row({
    threadsRespondable: 20,
    threadsAnswered: 16,
    threadsAnsweredWithinTarget: 11,
    threadsAwaitingReply: 12,
    threadsOverdue: 6,
    threadsStale: 2,
    oldestWaitingSeconds: 5 * 24 * 60 * 60,
  });
  const first = exceptionsFor({ metrics, coverage: "COVERED" }, policy);
  const second = exceptionsFor({ metrics, coverage: "COVERED" }, policy);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((f) => f.kind),
    ["STALE_WAITING", "OVERDUE_WAITING", "UNANSWERED", "ANSWERED_LATE", "PENDING_BACKLOG"],
  );
});

test("every flag explains itself and carries exactly one recommendation", () => {
  const metrics = row({
    threadsRespondable: 20,
    threadsAnswered: 16,
    threadsAnsweredWithinTarget: 11,
    threadsAwaitingReply: 12,
    threadsOverdue: 6,
    threadsStale: 2,
    oldestWaitingSeconds: 5 * 24 * 60 * 60,
  });
  const flags = exceptionsFor({ metrics, coverage: "COVERED" }, policy);
  const advice = recommendationsFor(flags);

  assert.equal(advice.length, flags.length);
  for (const [index, entry] of flags.entries()) {
    assert.ok(entry.reason.length > 0, `${entry.kind} has no reason`);
    assert.ok(entry.reason.includes(String(entry.observed)), entry.reason);
    assert.equal(advice[index]?.forKind, entry.kind);
    assert.ok((advice[index]?.text.length ?? 0) > 0, `${entry.kind} has no recommendation`);
  }
});

test("the nested counts can never contradict each other on screen", () => {
  // stale ⊆ overdue ⊆ waiting, and within-target ⊆ answered ⊆ respondable.
  // Asserted here so a fixture that violates them fails loudly rather than
  // producing a plausible, impossible report.
  const metrics = row({
    threadsRespondable: 20,
    threadsAnswered: 16,
    threadsAnsweredWithinTarget: 11,
    threadsAwaitingReply: 12,
    threadsOverdue: 6,
    threadsStale: 2,
  });
  assert.ok(metrics.threadsStale <= metrics.threadsOverdue);
  assert.ok(metrics.threadsOverdue <= metrics.threadsAwaitingReply);
  assert.ok(metrics.threadsAnsweredWithinTarget <= metrics.threadsAnswered);
  assert.ok(metrics.threadsAnswered <= metrics.threadsRespondable);
});

test("each recommendation belongs to its own exception, with that exception's number", () => {
  // Every performance kind at once: late, unanswered, overdue, stale, backlog.
  const metrics = row({
    threadsRespondable: 30,
    threadsAnswered: 24,
    threadsAnsweredWithinTarget: 17,
    threadsAwaitingReply: 13,
    threadsOverdue: 5,
    threadsStale: 3,
    oldestWaitingSeconds: 4 * 24 * 60 * 60,
  });
  const flags = exceptionsFor({ metrics, coverage: "COVERED" }, policy);
  assert.deepEqual(
    flags.map((f) => f.kind).sort(),
    ["ANSWERED_LATE", "OVERDUE_WAITING", "PENDING_BACKLOG", "STALE_WAITING", "UNANSWERED"],
  );
  // Each kind at most once, so pairing by position is unambiguous.
  assert.equal(new Set(flags.map((f) => f.kind)).size, flags.length);

  const advice = recommendationsFor(flags);
  assert.equal(advice.length, flags.length);
  for (const [index, flag] of flags.entries()) {
    const line = advice[index]!;
    assert.equal(line.forKind, flag.kind);
    assert.ok(line.text.includes(String(flag.observed)), `${flag.kind}: "${line.text}" lacks ${flag.observed}`);
  }
});

test("an unconnected mailbox gets exactly one paired line", () => {
  const flags = exceptionsFor({ metrics: null, coverage: "NO_GMAIL" }, policy);
  const advice = recommendationsFor(flags);
  assert.deepEqual(flags.map((f) => f.kind), ["NOT_COVERED"]);
  assert.deepEqual(advice.map((a) => a.forKind), ["NOT_COVERED"]);
});
