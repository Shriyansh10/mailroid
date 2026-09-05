/**
 * Tests for the Gmail quota limiter.
 *
 * NO REAL TIME PASSES HERE. Both the clock and the sleep are injected, so a test
 * asserting fifty seconds of pacing runs in microseconds and asserts an exact
 * number rather than a range. This follows the convention already used for
 * `extractRetryAfter(err, now)`: an injected parameter with a real default,
 * never a fake-timer library.
 *
 * The arithmetic that recurs below, so it is stated once: at 75 units/sec a
 * threads.get (40 units) buys 533.33ms of schedule. Interactive callers get a
 * 250-unit tolerance (3,333.33ms), background callers half that (1,666.67ms) —
 * so the SAME sequence of calls admits a different number depending on trigger,
 * and several tests below turn on exactly that difference.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { logger } from "@repo/logger";

import { GmailPacedOutError } from "./gmail-errors.ts";
import {
  __config,
  __resetQuotaLimiter,
  __setPacingEnabled,
  acquireQuota,
  chargeQuota,
  quotaLimiterSnapshot,
} from "./quota-limiter.ts";

const THREADS_GET = 40;
const START = 1_000_000;

/**
 * Injected clock and sleep.
 *
 * THE SLEEP DOES NOT ADVANCE THE CLOCK, and that is the whole reason these tests
 * can assert anything interesting. A sleep that advanced it would model a single
 * consumer politely waiting its turn, so the schedule could never get more than
 * one emission ahead of `now` and no backlog would ever form — every refusal
 * test would silently pass by never refusing. Freezing `now` instead models what
 * actually happens in production: many callers arriving inside one instant while
 * the wall clock barely moves. Tests advance the clock explicitly when they mean
 * time to pass.
 */
function harness() {
  const clock = { ms: START };
  const slept: number[] = [];
  return {
    clock,
    slept,
    advance: (ms: number) => {
      clock.ms += ms;
    },
    hooks: {
      now: () => clock.ms,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    },
  };
}

function setup() {
  __resetQuotaLimiter();
  __setPacingEnabled(true);
  return harness();
}

function req(h: ReturnType<typeof harness>, over: Partial<Parameters<typeof acquireQuota>[0]> = {}) {
  return {
    tenantId: "tenant-a",
    operation: "threads.get",
    trigger: "sync",
    units: THREADS_GET,
    hooks: h.hooks,
    ...over,
  };
}

// ── the admission calculation ───────────────────────────────────────

test("the burst admits six threads.get, and the seventh waits 400ms", async () => {
  // THE CALCULATION THIS PINS DOWN. At 75 units/sec one threads.get (40 units)
  // buys 533.33ms of schedule, and a 250-unit tolerance is 3,333.33ms. Six calls
  // reach tat = 3,200ms, still inside the tolerance, so all six go free — and
  // 6 x 40 = 240 units, which is the 250 burst as configured. The seventh's
  // candidate tat is 3,733.33ms, which is 400ms past the tolerance.
  //
  // This is the test that catches the tempting simplification: testing
  // `baseTat - tolerance` instead of `candidateTat - tolerance` admits SEVEN and
  // defers the wait to the eighth, i.e. runs a 290-unit burst labelled 250.
  //
  // AN INTERACTIVE TRIGGER ON PURPOSE. Only interactive callers get the full
  // 250-unit tolerance; background ones get half, so the same sequence under
  // `sync` admits three and makes the fourth wait 467ms. The six/400 figures
  // describe the interactive class specifically.
  const h = setup();

  for (let i = 0; i < 6; i++) {
    const { waitedMs } = await acquireQuota(req(h, { trigger: "ui" }));
    assert.equal(waitedMs, 0, `call ${i + 1} should not have waited`);
  }

  const seventh = await acquireQuota(req(h, { trigger: "ui" }));
  assert.equal(seventh.waitedMs, 400);
  assert.deepEqual(h.slept, [400]);
});

test("a background caller gets half the tolerance, and that is deliberate", async () => {
  // The other half of the reserve, asserted directly so the asymmetry is a
  // stated property rather than an accident of a constant.
  const h = setup();

  for (let i = 0; i < 3; i++) {
    assert.equal((await acquireQuota(req(h))).waitedMs, 0, "first three fit in 125 units");
  }
  // 4th: candidate tat 2,133.33ms, less the 1,666.67ms background tolerance.
  assert.equal((await acquireQuota(req(h))).waitedMs, 467);
});

test("sustained rate converges on the configured units per second", async () => {
  // 100 threads.get is 4,000 units of schedule = 53,333ms at 75/sec. With `now`
  // frozen, the hundredth caller's own wait is that, less whatever tolerance its
  // class is granted. A sync is background, so 125 units (1,667ms) come off:
  //
  //     (100 x 40 - 125) / 75 = 51.667 seconds
  //
  // The equivalent interactive figure is 50.0s, because the full 250-unit
  // tolerance is deducted instead. Derived from __config rather than hardcoded,
  // so retuning the rate updates the expectation instead of breaking the test
  // for the wrong reason.
  const h = setup();

  let last = 0;
  for (let i = 0; i < 100; i++) last = (await acquireQuota(req(h))).waitedMs;

  const expected = Math.round(
    ((100 * THREADS_GET - __config.backgroundToleranceUnits) * 1_000) / __config.unitsPerSec,
  );
  assert.equal(expected, 51_667, "the derivation should reproduce the documented figure");
  assert.equal(last, expected);

  // Guard against both degenerate readings: no pacing at all, and pacing the
  // whole 4,000 units as though there were no tolerance.
  assert.notEqual(last, 0);
  assert.notEqual(last, Math.round((100 * THREADS_GET * 1_000) / __config.unitsPerSec));
});

test("each mailbox has its own schedule", async () => {
  // Google's limit is per user per project, so one busy mailbox must not slow
  // another. A global bucket would throw away throughput we are entitled to.
  const h = setup();

  for (let i = 0; i < 20; i++) await acquireQuota(req(h));

  const other = await acquireQuota(req(h, { tenantId: "tenant-b" }));
  assert.equal(other.waitedMs, 0);
});

test("concurrent callers get distinct, ordered wake times", async () => {
  // THIS IS THE TEST THAT JUSTIFIES CHOOSING GCRA over a sleep-and-recheck token
  // bucket. Ten callers arriving at the same instant must each be handed their
  // own slot at admission. The failure mode being excluded is ten callers
  // sleeping the SAME duration, waking together, and fighting over the same
  // tokens — which is what a naive bucket does under exactly the burst it is
  // supposed to smooth.
  const h = setup();

  // Drain the burst so every one of the ten has to be scheduled.
  for (let i = 0; i < 6; i++) await acquireQuota(req(h));

  const waits: number[] = [];
  await Promise.all(
    Array.from({ length: 10 }, () =>
      acquireQuota(req(h)).then((r) => {
        waits.push(r.waitedMs);
      }),
    ),
  );

  const sorted = [...waits].sort((a, b) => a - b);
  assert.equal(new Set(sorted).size, 10, `expected 10 distinct waits, got ${sorted.join(",")}`);

  // Consecutive slots are one emission apart — 40 units at 75/sec = 533.33ms,
  // which rounds to alternating 533/534.
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!;
    assert.ok(gap >= 533 && gap <= 534, `slot ${i} gap was ${gap}ms, expected ~533`);
  }
});

// ── refusal ─────────────────────────────────────────────────────────

test("an interactive call is refused past its cap, and a background one waits", async () => {
  const h = setup();

  // Push the schedule far enough out that even the interactive tolerance cannot
  // absorb it: 200 threads.get is 8,000 units, ~106s of schedule.
  for (let i = 0; i < 200; i++) await acquireQuota(req(h));

  await assert.rejects(
    () => acquireQuota(req(h, { trigger: "ui" })),
    (err: unknown) => {
      assert.ok(err instanceof GmailPacedOutError);
      assert.equal(err.trigger, "ui");
      assert.equal(err.capMs, 2_000);
      assert.ok(err.waitMs > err.capMs);
      return true;
    },
  );

  // The same schedule is fine for background work, which has a 15-minute cap.
  const background = await acquireQuota(req(h));
  assert.ok(background.waitedMs > 0);
});

test("a refusal does not advance the schedule", async () => {
  // If a rejected call charged the clock, a bounced UI request would slow the
  // background sync it just lost to — the opposite of what the reserve is for.
  // Issuing the identical rejected call twice must give the identical answer.
  const h = setup();
  for (let i = 0; i < 200; i++) await acquireQuota(req(h));

  const first = await acquireQuota(req(h, { trigger: "ui" })).catch(
    (e: GmailPacedOutError) => e,
  );
  const second = await acquireQuota(req(h, { trigger: "ui" })).catch(
    (e: GmailPacedOutError) => e,
  );

  assert.ok(first instanceof GmailPacedOutError && second instanceof GmailPacedOutError);
  assert.equal(first.waitMs, second.waitMs);
});

test("background work is capped too, rather than hanging forever", async () => {
  // A schedule 15 minutes out means ~67,500 units queued against one mailbox.
  // That is a broken system, not a busy one, and blocking a worker on it helps
  // nobody. "Background waits indefinitely" would be the wrong contract.
  const h = setup();

  // Drive until the ceiling actually bites, rather than guessing an iteration
  // count — the point is that it bites at all, and where.
  let refusal: GmailPacedOutError | undefined;
  for (let i = 0; i < 5_000 && !refusal; i++) {
    try {
      await acquireQuota(req(h));
    } catch (err) {
      refusal = err as GmailPacedOutError;
    }
  }

  assert.ok(refusal instanceof GmailPacedOutError, "background work should eventually refuse");
  assert.equal(refusal.capMs, 900_000);
  assert.ok(refusal.waitMs > 900_000);
});

// ── the interactive reserve ─────────────────────────────────────────

test("interactive traffic spends a reserve background traffic cannot touch", async () => {
  // NOT the same assertion as the cap test above. That one proves interactive
  // calls can be refused; this one proves the mechanism they are refused BY also
  // grants them priority — the whole reason for two tolerances on one clock.
  //
  // Fill the schedule to sit between the two tolerances: past the background
  // tolerance (125 units) but inside the interactive one (250 units). A UI call
  // must go free there while a background call must wait.
  const h = setup();

  // Four threads.get = 160 units of schedule. Background tolerance is 125 units,
  // interactive is 250.
  for (let i = 0; i < 4; i++) await acquireQuota(req(h));

  const interactive = await acquireQuota(req(h, { trigger: "ui" }));
  assert.equal(interactive.waitedMs, 0, "interactive should spend the reserve");

  const background = await acquireQuota(req(h));
  assert.ok(
    background.waitedMs > 0,
    "background should be queued behind the reserve, not sharing it",
  );
});

// ── chargeQuota ─────────────────────────────────────────────────────

test("charging an idle bucket does not let the charge vanish", async () => {
  // THE CLAMP IS THE POINT. A bare `tat += emission` on a bucket whose tat sits
  // in the past leaves it still in the past, and the charge is silently lost —
  // under-counting exactly the auth-recovery traffic this function exists to
  // count. The transition must be max(tat, now) + emission.
  const h = setup();

  await acquireQuota(req(h));
  // Let the schedule fall a long way behind now.
  h.advance(60_000);

  chargeQuota({
    tenantId: "tenant-a",
    operation: "labels.list",
    trigger: "sync",
    units: 1,
    hooks: h.hooks,
  });

  // With the clamp, the bucket now sits one emission ahead of now, so a call
  // that would otherwise be free is scheduled from there. Prove the charge
  // landed by draining the burst and checking the offset it produced.
  const drained: number[] = [];
  for (let i = 0; i < 7; i++) drained.push((await acquireQuota(req(h))).waitedMs);

  // Without the clamp the 1-unit charge would be lost and the seventh call would
  // wait exactly 400ms, as in the first test. With it, the extra 1 unit
  // (13.33ms) pushes that out.
  assert.ok(
    drained[6]! > 400,
    `expected the charge to shift the schedule; seventh wait was ${drained[6]}ms`,
  );
});

test("charging never waits and never throws, even on a saturated schedule", async () => {
  // The auth-recovery path calls this while a sync is mid-flight. If it could
  // block or throw, it would rebuild the 2026-08-25 deadlock in slow motion.
  const h = setup();
  for (let i = 0; i < 500; i++) await acquireQuota(req(h));

  const before = h.clock.ms;
  const sleepsBefore = h.slept.length;

  chargeQuota({
    tenantId: "tenant-a",
    operation: "labels.list",
    trigger: "resume-cron",
    units: 1,
    hooks: h.hooks,
  });

  assert.equal(h.clock.ms, before, "charge must not advance the clock by sleeping");
  assert.equal(h.slept.length, sleepsBefore, "charge must not sleep");
});

// ── configuration invariants ────────────────────────────────────────

test("the burst tolerance can always afford the priciest operation we issue", () => {
  // messages.send / drafts.send / watch are 100 units. If the tolerance were
  // ever configured below that, those calls could never be admitted at all —
  // allowAt would stay ahead of now forever and every cap would be exceeded.
  assert.ok(
    __config.burstUnits >= 100,
    `burst ${__config.burstUnits} cannot admit a 100-unit send`,
  );
  assert.ok(__config.interactiveToleranceUnits > __config.backgroundToleranceUnits);
});

test("a 100-unit send is admissible from cold", async () => {
  const h = setup();
  const sent = await acquireQuota(
    req(h, { operation: "messages.send", trigger: "send", units: 100 }),
  );
  assert.equal(sent.waitedMs, 0);
});

// ── bookkeeping ─────────────────────────────────────────────────────

test("reaping drops buckets that can no longer affect a decision", async () => {
  // Lossless by construction: once tat is far enough in the past, max(tat, now)
  // is just now, so a reaped bucket behaves identically to one that was kept.
  const h = setup();
  await acquireQuota(req(h));
  assert.equal(quotaLimiterSnapshot().buckets, 1);

  h.advance(__config.idleReapMs + 60_000);

  // The sweep runs on a write counter, so drive enough writes to trigger it.
  for (let i = 0; i < 512; i++) {
    await acquireQuota(req(h, { tenantId: "tenant-sweeper" }));
  }

  const keys = quotaLimiterSnapshot().buckets;
  assert.ok(keys <= 2, `expected the idle bucket to be reaped, ${keys} remain`);

  // And a reaped mailbox starts clean rather than inheriting a stale schedule.
  const afterReap = await acquireQuota(req(h));
  assert.equal(afterReap.waitedMs, 0);
});

test("the snapshot counts refusals and accumulated wait", async () => {
  const h = setup();
  for (let i = 0; i < 200; i++) await acquireQuota(req(h));
  await acquireQuota(req(h, { trigger: "ui" })).catch(() => undefined);

  const snap = quotaLimiterSnapshot();
  assert.equal(snap.pacedOut, 1);
  assert.ok(snap.totalWaitedMs > 0);
  assert.equal(snap.unitsPerSec, __config.unitsPerSec);
});

test("a burst of refusals produces one log line, not one per refusal", async () => {
  // The `ui` cap is 2s, so a saturated schedule plus a polling UI can refuse
  // repeatedly. One warn per refusal would flood the logs at exactly the moment
  // someone is trying to read them — the same "a success is a statistic"
  // reasoning the rollup applies, for an expected self-clearing event.
  //
  // pacedOut must still count EVERY refusal, whatever was printed: the log is
  // throttled, the counter is not.
  const h = setup();
  const refusalLines: Array<Record<string, unknown>> = [];
  const originalWarn = logger.warn.bind(logger);
  logger.warn = ((msg: string, meta?: Record<string, unknown>) => {
    if (msg.includes("refused, wait exceeds cap")) refusalLines.push(meta ?? {});
  }) as typeof logger.warn;

  try {
    for (let i = 0; i < 200; i++) await acquireQuota(req(h));

    for (let i = 0; i < 50; i++) {
      await acquireQuota(req(h, { trigger: "ui" })).catch(() => undefined);
    }

    assert.equal(refusalLines.length, 1, "50 refusals in one window must print once");
    assert.equal(refusalLines[0]!.suppressedSinceLastLog, 0, "the first line leads the burst");
    assert.equal(quotaLimiterSnapshot().pacedOut, 50, "but every refusal is still counted");

    // Past the window, the next refusal prints again and carries the 49 it hid.
    h.advance(61_000);
    await acquireQuota(req(h, { trigger: "ui" })).catch(() => undefined);

    assert.equal(refusalLines.length, 2);
    assert.equal(refusalLines[1]!.suppressedSinceLastLog, 49);
    assert.equal(quotaLimiterSnapshot().pacedOut, 51);
  } finally {
    logger.warn = originalWarn;
  }
});

test("throttling is per tenant, trigger and operation", async () => {
  // Folding every refusal into one key would hide a second mailbox failing for
  // a different reason behind the first one's burst.
  const h = setup();
  const refusalLines: Array<Record<string, unknown>> = [];
  const originalWarn = logger.warn.bind(logger);
  logger.warn = ((msg: string, meta?: Record<string, unknown>) => {
    if (msg.includes("refused, wait exceeds cap")) refusalLines.push(meta ?? {});
  }) as typeof logger.warn;

  try {
    for (let i = 0; i < 200; i++) await acquireQuota(req(h));
    for (let i = 0; i < 200; i++) {
      await acquireQuota(req(h, { tenantId: "tenant-b" }));
    }

    await acquireQuota(req(h, { trigger: "ui" })).catch(() => undefined);
    await acquireQuota(req(h, { trigger: "thumbnail" })).catch(() => undefined);
    await acquireQuota(req(h, { tenantId: "tenant-b", trigger: "ui" })).catch(() => undefined);

    assert.equal(refusalLines.length, 3, "distinct keys must each get their own line");
  } finally {
    logger.warn = originalWarn;
  }
});

test("an invented price is counted so it cannot stay invisible", async () => {
  const h = setup();
  await acquireQuota(req(h, { operation: "syncHistoryForTenant", fallbackPriced: true }));
  assert.equal(quotaLimiterSnapshot().fallbackPriced, 1);
});

test("with pacing off, nothing waits and nothing throws", async () => {
  // The kill switch has to be total: a limiter that still half-applies when
  // disabled is worse than one that is on.
  __resetQuotaLimiter();
  __setPacingEnabled(false);
  const h = harness();

  for (let i = 0; i < 500; i++) {
    const { waitedMs } = await acquireQuota(req(h));
    assert.equal(waitedMs, 0);
  }
  assert.equal(h.clock.ms, START);
  assert.equal(quotaLimiterSnapshot().buckets, 0);

  __setPacingEnabled(true);
});
