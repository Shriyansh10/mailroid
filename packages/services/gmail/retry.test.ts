/**
 * Tests for withGmailRetry's ordering and accounting.
 *
 * This is the file the `hooks` seam at retry.ts was written for — it lets the
 * whole wrapper run with no database, no network and no real clock.
 *
 * WHAT IS WORTH ASSERTING HERE. Three of these properties are invisible when
 * wrong: a gate that runs after pacing wastes a wait on a call that was never
 * going to happen; a pacing refusal recorded as a Gmail call inflates the exact
 * egress figure the ledger exists to measure; and a pacing wait folded into
 * `durationMs` makes a correctly-paced call look like a slow one, whose obvious
 * "fix" is to raise the rate limit. None of them throws, so only a test catches
 * them.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { GmailPacedOutError } from "./gmail-errors.ts";
import type { GmailCallRecord } from "./call-ledger.ts";
import { withGmailRetry } from "./retry.ts";

interface Harness {
  records: GmailCallRecord[];
  acquired: Array<{ operation: string; trigger: string; units: number }>;
  gated: string[];
  clock: { ms: number };
  hooks: NonNullable<Parameters<typeof withGmailRetry>[2]>["hooks"];
}

/**
 * `waitedMsPerAcquire` makes the injected limiter advance the injected clock by
 * the same amount it claims to have waited — which is what makes the durationMs
 * assertion below meaningful rather than tautological.
 */
function harness(opts: { waitedMsPerAcquire?: number; gateThrows?: Error } = {}): Harness {
  const records: GmailCallRecord[] = [];
  const acquired: Harness["acquired"] = [];
  const gated: string[] = [];
  const clock = { ms: 5_000_000 };

  return {
    records,
    acquired,
    gated,
    clock,
    hooks: {
      now: () => clock.ms,
      assertSyncAllowed: async (tenantId: string) => {
        gated.push(tenantId);
        if (opts.gateThrows) throw opts.gateThrows;
      },
      handleGmailFailure: async () => {},
      markGmailHealthy: async () => {},
      recordGmailCall: (record: GmailCallRecord) => {
        records.push(record);
      },
      acquireQuota: async (req) => {
        acquired.push({ operation: req.operation, trigger: req.trigger, units: req.units });
        const waitedMs = opts.waitedMsPerAcquire ?? 0;
        clock.ms += waitedMs;
        return { waitedMs, units: req.units };
      },
      // P-5a: no database in this suite (see the file header) — a real
      // resolver call would hit gmail_tenant_mappings and fail/warn on every
      // test. undefined is a legitimate resolver outcome (bucketKey falls
      // back to tenantId), so it's also the right stub value.
      resolveMailbox: async () => undefined,
    },
  };
}

// ── ordering ────────────────────────────────────────────────────────

test("the cooldown gate runs before pacing, never after", async () => {
  // A mailbox in a 60-minute cooldown must be refused instantly and for free.
  // Sleeping two seconds first and THEN reporting it unavailable wastes the wait
  // and burns a schedule slot on a call that is never made.
  const refusal = new Error("cooling down");
  const h = harness({ gateThrows: refusal });

  await assert.rejects(
    () =>
      withGmailRetry("threads.get abc", async () => "never", {
        tenantId: "tenant-a",
        trigger: "sync",
        hooks: h.hooks,
      }),
    (err) => err === refusal,
  );

  assert.deepEqual(h.gated, ["tenant-a"]);
  assert.equal(h.acquired.length, 0, "pacing must not have been consulted");
  assert.equal(h.records.length, 0, "a gated call is not a Gmail call");
});

test("the operation's real quota cost is what gets reserved", async () => {
  const h = harness();
  await withGmailRetry("threads.get abc", async () => "ok", {
    tenantId: "tenant-a",
    trigger: "sync",
    hooks: h.hooks,
  });

  assert.equal(h.acquired.length, 1);
  assert.equal(h.acquired[0]!.operation, "threads.get");
  assert.equal(h.acquired[0]!.units, 40, "threads.get is 40 units, not 1 request");
});

test("every network attempt reserves quota, not just the first", async () => {
  // A 4-retry storm that reserved once would spend 5x what the limiter admitted.
  const h = harness();
  let calls = 0;

  const result = await withGmailRetry(
    "messages.get abc",
    async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("bad gateway"), { status: 502 });
      return "ok";
    },
    { tenantId: "tenant-a", trigger: "sync", baseDelayMs: 1, hooks: h.hooks },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.equal(h.acquired.length, 2, "the retry must reserve again");
  assert.equal(h.records[0]!.attempts, 2);
});

// ── accounting ──────────────────────────────────────────────────────

test("durationMs excludes the pacing wait", async () => {
  // THE LEDGER'S CENTRAL CLAIM, tested for the first time. `durationMs` answers
  // "how slow is Gmail"; `waitedMs` answers "how hard are we throttling
  // ourselves". Summing them makes a healthy paced call indistinguishable from a
  // slow one, and the natural response to that reading is to raise the rate.
  const h = harness({ waitedMsPerAcquire: 500 });

  await withGmailRetry(
    "threads.get abc",
    async () => {
      h.clock.ms += 120; // Gmail's own latency.
      return "ok";
    },
    { tenantId: "tenant-a", trigger: "sync", hooks: h.hooks },
  );

  const record = h.records[0]!;
  assert.equal(record.durationMs, 120, "the 500ms pacing wait must not be in here");
  assert.equal(record.waitedMs, 500, "but it must be reported");
});

test("a pacing refusal is not recorded as a Gmail call", async () => {
  // Same reasoning already written down for the cooldown gate: a call refused
  // before the network never reached Google, and booking it would inflate the
  // egress figure the ledger exists to measure.
  const h = harness();
  const paced = new GmailPacedOutError({
    tenantId: "tenant-a",
    operation: "threads.get",
    trigger: "ui",
    waitMs: 5_000,
    capMs: 2_000,
  });
  h.hooks!.acquireQuota = async () => {
    throw paced;
  };

  let reached = false;
  await assert.rejects(
    () =>
      withGmailRetry(
        "threads.get abc",
        async () => {
          reached = true;
          return "ok";
        },
        { tenantId: "tenant-a", trigger: "ui", hooks: h.hooks },
      ),
    (err) => err === paced,
  );

  assert.equal(reached, false, "the call must not have gone out");
  assert.equal(h.records.length, 0);
});

test("a pacing refusal on a retry surfaces the original failure", async () => {
  // If attempt 1 got a 502 and attempt 2 cannot be scheduled, the caller needs
  // to hear about the 502. Replacing it with the pacing refusal would send
  // whoever reads the log looking at our limiter instead of at Google.
  const h = harness();
  const upstream = Object.assign(new Error("bad gateway"), { status: 502 });
  let acquires = 0;
  h.hooks!.acquireQuota = async (req) => {
    acquires++;
    if (acquires > 1) {
      throw new GmailPacedOutError({
        operation: req.operation,
        trigger: req.trigger,
        waitMs: 999_999,
        capMs: 900_000,
      });
    }
    return { waitedMs: 0, units: req.units };
  };

  await assert.rejects(
    () =>
      withGmailRetry(
        "messages.get abc",
        async () => {
          throw upstream;
        },
        { tenantId: "tenant-a", trigger: "sync", baseDelayMs: 1, hooks: h.hooks },
      ),
    (err) => {
      assert.equal(err, upstream, "must be the 502, not the pacing error");
      assert.ok(!(err instanceof GmailPacedOutError));
      return true;
    },
  );

  // And the failed call IS recorded — it did reach the network once.
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0]!.ok, false);
  assert.equal(h.records[0]!.attempts, 1);
});

test("an unpriced operation is still paced, and flagged as invented", async () => {
  // `syncHistoryForTenant` names a function, not a Gmail method, so no quota
  // table has a row for it. It must not therefore cost zero.
  const h = harness();
  const seen: Array<boolean | undefined> = [];
  h.hooks!.acquireQuota = async (req) => {
    seen.push(req.fallbackPriced);
    return { waitedMs: 0, units: req.units };
  };

  await withGmailRetry("syncHistoryForTenant", async () => "ok", {
    tenantId: "tenant-a",
    trigger: "webhook",
    hooks: h.hooks,
  });

  assert.equal(seen[0], true);
  assert.equal(h.acquired.length, 0); // replaced the hook, so use `seen`
});
