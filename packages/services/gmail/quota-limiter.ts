/**
 * Per-mailbox Gmail quota pacing.
 *
 * THE BUG THIS EXISTS TO FIX. Nothing in this codebase paced Gmail calls, so the
 * actual call rate was an emergent property of host speed. One sync page costs
 * ~4,010 quota units (1x threads.list at 10, 100x threads.get at 40). A 1 vCPU
 * production box completes that page in ~60s — about 65 units/sec, comfortably
 * inside budget. A 12-thread workstation completes the identical page in ~1.5s,
 * which is ~2,670 units/sec and roughly 26x over. Same code, same config; only
 * the machine differed. That is not a tuning problem, it is an absent control.
 *
 * TWO SEPARATE CONTROLS, AND THIS IS ONLY ONE OF THEM. Google enforces a
 * quota-unit budget AND a separate per-user concurrent-request limit, and 429s
 * can also come from bandwidth limits.
 *
 *     this module          -> quota units admitted over time
 *     mapWithConcurrency   -> how many requests are in flight at once
 *
 * Neither substitutes for the other. Do not delete one because the other exists.
 *
 * IT CANNOT PREVENT EVERY 429. It addresses the quota-rate family only. The
 * cooldown ladder in quota-cooldown.ts remains the backstop for everything this
 * module cannot observe: the project-wide ceiling, concurrency and bandwidth
 * limits, and quota spent by anything else sharing the GCP project — which is
 * not hypothetical, since all seven production mailboxes share one.
 *
 * SINGLE PROCESS ONLY. The bucket map is module scope, so it describes the whole
 * fleet only because exactly one mailroid-api container runs today (see
 * .github/workflows/mailroid-deploy.yml). A second replica, an out-of-process
 * worker, or a script run against a live mailbox each gets its own map, and the
 * real rate becomes N x the configured one. Run one-off scripts with a reduced
 * GMAIL_QUOTA_UNITS_PER_SEC. If you scale out, the fix is to move `readTat` /
 * `writeTat` onto Redis — the entire state is one number per tenant, which is
 * what makes that a swap rather than a rewrite.
 *
 * DEPENDENCY BUDGET, DELIBERATELY TINY: @repo/logger and the pure ./gmail-errors
 * only. Same rule as call-ledger.ts, and for the same reason — gmail-request.ts
 * imports this module and must not be able to reach a gate through it. There is
 * a test asserting the import list.
 */

import { logger } from "@repo/logger";

import { GmailPacedOutError } from "./gmail-errors.ts";

// ── configuration ───────────────────────────────────────────────────

/**
 * Sustained target, in quota units per second, per mailbox.
 *
 * Google documents 6,000 units/minute/user/project, i.e. a 100/sec average. 75
 * is a deliberately conservative application target against that budget — NOT a
 * claim that Google enforces a hard 100-per-second instantaneous ceiling. The
 * published quota is a per-minute budget; this is an application-side
 * approximation designed to sit under it, not a replica of Google's enforcement.
 *
 *     6,000 / 60 = 100 units/sec   documented average allowance
 *                -  75 units/sec   this target
 *                =  25 units/sec   headroom
 *
 * The headroom is reserved for traffic this limiter cannot see or deliberately
 * does not admit: the auth-recovery bypass (charged, never admitted), corsair's
 * own internal retries, the unauthenticated egress probe, and any call site not
 * yet routed through a wrapper.
 *
 * THE QUOTA TIER IS PROJECT-SPECIFIC. Google states that projects which used the
 * Gmail API between November 2025 and April 2026 retain their previous quota
 * settings. A project on an older tier needs its own value here, derived the
 * same way. Confirm per project in the Cloud console before enabling pacing.
 */
const DEFAULT_UNITS_PER_SEC = 75;

/**
 * Burst tolerance in quota units. OUR pacing policy, not a Google-documented
 * burst allowance — Google publishes no such figure. 250 units is ~4% of the
 * minute budget, and is what lets an idle mailbox answer a webhook immediately
 * instead of being throttled from cold for no reason.
 */
const DEFAULT_BURST_UNITS = 250;

/**
 * The burst floor is load-bearing, not defensive rounding.
 *
 * A call can never be admitted if its own cost exceeds the tolerance: `allowAt`
 * would stay ahead of `now` forever and every cap would be exceeded. So the
 * tolerance must be at least the most expensive operation MAILROID ISSUES —
 * messages.send, drafts.send and watch, all 100. Scoped to our own operation set
 * on purpose: Google's table has other 100-unit methods (settings, among others)
 * that this app never calls. If a costlier operation is ever added, raise this.
 */
const MIN_BURST_UNITS = 100;

function clampedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn("[GMAIL_PACING] ignoring unparseable override", { name, raw, fallback });
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, parsed));
  if (clamped !== parsed) {
    logger.warn("[GMAIL_PACING] override clamped", { name, requested: parsed, applied: clamped });
  }
  return clamped;
}

const UNITS_PER_SEC = clampedEnvInt("GMAIL_QUOTA_UNITS_PER_SEC", DEFAULT_UNITS_PER_SEC, 1, 250);
const BURST_UNITS = clampedEnvInt(
  "GMAIL_QUOTA_BURST_UNITS",
  DEFAULT_BURST_UNITS,
  MIN_BURST_UNITS,
  1_000,
);

/**
 * OPT-OUT, and on unless explicitly switched off (P-8,
 * docs/gmail-rate-limit-boundary.md §13).
 *
 * This inverts the original opt-in design. The pre-flight checks that
 * justified opt-in — confirm the GCP quota tier per project, confirm a ~50s
 * paced sync page fits inside the Inngest step and proxy timeouts — were the
 * argument FOR shipping unpaced by default while they were pending. They are
 * no longer pending, and the 2026-08-25 incident is what an unpaced call rate
 * costs when nobody remembered to flip the switch: pacing that a developer has
 * to opt into is pacing that is off by default in every environment where
 * nobody thought to ask. Every Gmail call in the product now awaits this
 * module, so the failure mode of defaulting on is "briefly conservative
 * throughput"; the failure mode of defaulting off is this document's §2.1.
 *
 * The one-env-var escape hatch is kept, inverted: set GMAIL_QUOTA_PACING=off
 * to disable, e.g. for a one-off script that wants the raw call rate.
 */
const PACING_ENABLED_AT_BOOT = process.env.GMAIL_QUOTA_PACING !== "off";

/**
 * Mutable so tests can exercise the algorithm without the env var, and so the
 * boot-time value stays readable in `quotaLimiterSnapshot()`. Production code
 * never writes this — only `__setPacingEnabled`, which is a test seam.
 */
let pacingEnabled = PACING_ENABLED_AT_BOOT;

/** Milliseconds of schedule one unit buys. */
const MS_PER_UNIT = 1_000 / UNITS_PER_SEC;

// ── trigger policy ──────────────────────────────────────────────────

/**
 * Interactive triggers get a larger tolerance AND a short cap.
 *
 * The larger tolerance is the important half. With a sync running, reservations
 * sit ahead of `now`; if interactive traffic shared the background tolerance it
 * would bounce off its own 2-second cap during perfectly normal operation. Two
 * tolerances against one clock gives interactive callers a reserve — the gap
 * between the two numbers — that background traffic structurally cannot spend.
 *
 * This is the deliberate departure from FIFO. Ordering is FIFO WITHIN a
 * tolerance class; interactive calls are allowed to jump background
 * reservations, which is the entire point.
 */
const INTERACTIVE_TRIGGERS: ReadonlySet<string> = new Set([
  "ui",
  "thumbnail",
  "attachment-download",
  "send",
  "oauth-callback",
]);

const INTERACTIVE_TOLERANCE_UNITS = BURST_UNITS;
const BACKGROUND_TOLERANCE_UNITS = Math.floor(BURST_UNITS / 2);

/**
 * How long a caller will wait before being refused.
 *
 * Background gets 15 minutes rather than "forever": a schedule 15 minutes out
 * means ~67,500 units are queued against a single mailbox, which is a broken
 * system rather than a busy one, and hanging a worker on it helps nobody. It
 * should never fire in normal operation.
 */
const CAP_MS: Readonly<Record<string, number>> = {
  ui: 2_000,
  thumbnail: 2_000,
  "attachment-download": 2_000,
  "oauth-callback": 5_000,
  // A person pressed Send. Failing that outright is worse than a short wait,
  // but hanging it behind a multi-hour sync is not acceptable either.
  send: 10_000,
  calendar: 30_000,
  // `unknown` is background for now and fails eventually rather than hanging.
  // Tighten once every call site is attributed — an `unknown` in a summary is
  // already treated as a finding by the ledger.
  unknown: 30_000,
};

const BACKGROUND_CAP_MS = 900_000;

function isInteractive(trigger: string): boolean {
  return INTERACTIVE_TRIGGERS.has(trigger);
}

function toleranceMsFor(trigger: string): number {
  const units = isInteractive(trigger)
    ? INTERACTIVE_TOLERANCE_UNITS
    : BACKGROUND_TOLERANCE_UNITS;
  return units * MS_PER_UNIT;
}

function capMsFor(trigger: string): number {
  return CAP_MS[trigger] ?? BACKGROUND_CAP_MS;
}

// ── bucket state ────────────────────────────────────────────────────

interface Bucket {
  /** Theoretical arrival time: the instant this mailbox's schedule is free. */
  tat: number;
  lastTouchedMs: number;
}

const buckets = new Map<string, Bucket>();

/** Beyond this, a bucket is indistinguishable from one that never existed. */
const IDLE_REAP_MS = 10 * 60_000;
const MAX_BUCKETS = 5_000;
const SWEEP_EVERY = 512;

let sinceSweep = 0;
let pacedOutCount = 0;
let totalWaitedMs = 0;
let fallbackPricedCount = 0;

/**
 * Refusal logging is throttled per (tenant, trigger, operation).
 *
 * A refusal is worth a line — but one line PER refusal is not. The `ui` cap is
 * two seconds, so a saturated schedule plus a polling UI can produce a burst of
 * them, at warn level, in the middle of the incident you are trying to read.
 * That is the "a success is a statistic" rule applied to an expected,
 * self-clearing event: the first occurrence is the document, the rest are a
 * count.
 *
 * NOTE THE TAIL. `suppressed` is reported on the NEXT line for that key, so if
 * refusals simply stop, the final few are never printed. That is deliberate —
 * this module owns no timer and is not going to grow one for a log line. The
 * authoritative total is `pacedOut` in quotaLimiterSnapshot(), which counts
 * every refusal regardless of what was printed.
 */
const REFUSAL_LOG_WINDOW_MS = 60_000;
const MAX_REFUSAL_KEYS = 1_000;

interface RefusalLog {
  lastLoggedAt: number;
  suppressed: number;
}

const refusalLogs = new Map<string, RefusalLog>();

/**
 * The only two functions that touch the map.
 *
 * Kept as a seam on purpose: the distributed version of this limiter is these
 * two backed by a Redis EVAL, and nothing else in the module changes. Retrofit
 * cost later is much higher than the cost of the indirection now.
 */
function readTat(key: string, now: number): number {
  return buckets.get(key)?.tat ?? now;
}

function writeTat(key: string, tat: number, now: number): void {
  const existing = buckets.get(key);
  if (existing) {
    existing.tat = tat;
    existing.lastTouchedMs = now;
    return;
  }
  buckets.set(key, { tat, lastTouchedMs: now });
}

/**
 * Drop buckets that no longer affect any decision.
 *
 * This is provably lossless, which is the quiet advantage of a virtual clock
 * over a counter: once `tat` is far enough in the past, `max(tat, now)` is just
 * `now`, so the bucket behaves exactly as an absent one would. Deleting it
 * cannot change a single admission.
 *
 * Runs on a write counter rather than a timer — a timer here would have to be
 * owned and stopped, and this module deliberately owns nothing.
 */
function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.tat < now - IDLE_REAP_MS) buckets.delete(key);
  }

  if (buckets.size <= MAX_BUCKETS) return;

  // Still over after the ordinary sweep: evict the coldest schedules first.
  // Never throw — a limiter that can fail a Gmail call has inverted its purpose.
  const byTat = [...buckets.entries()].sort((a, b) => a[1].tat - b[1].tat);
  for (const [key] of byTat.slice(0, buckets.size - MAX_BUCKETS)) {
    buckets.delete(key);
  }
  logger.warn("[GMAIL_PACING] bucket cap reached, evicted coldest", { cap: MAX_BUCKETS });
}

// ── public API ──────────────────────────────────────────────────────

export interface QuotaHooks {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface QuotaRequest {
  tenantId?: string;
  /**
   * P-5a (docs/gmail-rate-limit-boundary.md §13). The mailbox address, when
   * the caller has one — resolved OUTSIDE this module (see bucketKey below
   * for why) and passed in. Two tenants connected to the same mailbox (the
   * one-at-a-time shared-test-mailbox handover, §5) must pace against ONE
   * bucket, because that is Gmail's own key (§3.1: "shared by all Gmail API
   * clients for a user"); keying on tenantId alone lets them silently double
   * the real admitted rate against that mailbox.
   */
  mailbox?: string;
  operation: string;
  trigger: string;
  correlationId?: string;
  /**
   * Cost in quota units. Callers pass `quotaUnitsForPacing(operation)` from
   * call-ledger.ts — this module does not import that table itself, because
   * doing so would widen the dependency budget described in the header for no
   * benefit. `fallbackPriced` lets the caller tell us the price was invented, so
   * it can be counted and surfaced.
   */
  units: number;
  fallbackPriced?: boolean;
  hooks?: QuotaHooks;
}

const defaultNow = (): number => Date.now();
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * P-5a. Prefers `mailbox` — Gmail's own key — over `tenantId`, and never
 * resolves one from the other itself: this module's header commits to a
 * deliberately tiny dependency budget (@repo/logger and the pure
 * ./gmail-errors only), and a DB read to resolve a mailbox on the pacing hot
 * path would violate it. Resolution happens in the two callers that already
 * know the tenant — gmail-request.ts and retry.ts — via a cached resolver
 * (./mailbox-resolver.ts) that THEY import, not this module.
 *
 * Falls back to tenantId, then to the shared "unattributed" bucket, so a
 * resolver miss (mailbox not yet known, or a resolver failure) paces
 * CONSERVATIVELY rather than escaping pacing — same reasoning as the
 * original tenantId-only fallback below, one level down.
 */
function bucketKey(req: { mailbox?: string; tenantId?: string }): string {
  return req.mailbox ?? req.tenantId ?? "unattributed";
}

/**
 * Reserve quota for one call. May wait. May throw GmailPacedOutError.
 *
 * Returns the time actually spent waiting, so the caller can report it
 * separately from Gmail's own latency — see GmailCallRecord.waitedMs for why
 * those two must never be added together.
 */
export async function acquireQuota(
  req: QuotaRequest,
): Promise<{ waitedMs: number; units: number }> {
  if (!pacingEnabled) return { waitedMs: 0, units: req.units };

  const now = req.hooks?.now ?? defaultNow;
  const sleep = req.hooks?.sleep ?? defaultSleep;

  if (req.fallbackPriced) fallbackPricedCount += 1;

  const key = bucketKey(req);
  const at = now();

  if (++sinceSweep >= SWEEP_EVERY) {
    sinceSweep = 0;
    sweep(at);
  }

  const emissionMs = req.units * MS_PER_UNIT;
  const toleranceMs = toleranceMsFor(req.trigger);
  const capMs = capMsFor(req.trigger);

  // PRICE THIS CALL IN BEFORE TESTING ADMISSION. Testing `baseTat - tolerance`
  // instead would grant one extra emission of burst beyond the configured
  // tolerance — at 75 units/sec with a 250-unit tolerance that is a 290-unit
  // burst wearing a "250" label. The `+ emissionMs` is the whole difference.
  const baseTat = Math.max(readTat(key, at), at);
  const candidateTat = baseTat + emissionMs;
  const allowAt = candidateTat - toleranceMs;

  if (allowAt <= at) {
    writeTat(key, candidateTat, at);
    return { waitedMs: 0, units: req.units };
  }

  const waitMs = Math.round(allowAt - at);

  if (waitMs > capMs) {
    // DO NOT ADVANCE THE CLOCK ON A REFUSAL. A rejected call consumed nothing,
    // and charging it would let a bounced UI request slow the background sync it
    // just lost to — the opposite of what the reserve is for.
    pacedOutCount += 1;

    const logKey = `${req.tenantId ?? "unattributed"}|${req.trigger}|${req.operation}`;
    let entry = refusalLogs.get(logKey);
    if (!entry) {
      // Bounded like every other map here: a refused call must never be able to
      // grow memory without limit under exactly the storm it is describing.
      if (refusalLogs.size >= MAX_REFUSAL_KEYS) refusalLogs.clear();
      entry = { lastLoggedAt: -Infinity, suppressed: 0 };
      refusalLogs.set(logKey, entry);
    }

    if (at - entry.lastLoggedAt >= REFUSAL_LOG_WINDOW_MS) {
      logger.warn("[GMAIL_PACING] refused, wait exceeds cap", {
        tenantId: req.tenantId,
        operation: req.operation,
        trigger: req.trigger,
        correlationId: req.correlationId,
        waitMs,
        capMs,
        // Refusals for this same key folded into this line rather than printed
        // individually. Zero on the first line of a burst.
        suppressedSinceLastLog: entry.suppressed,
      });
      entry.lastLoggedAt = at;
      entry.suppressed = 0;
    } else {
      entry.suppressed += 1;
    }
    throw new GmailPacedOutError({
      tenantId: req.tenantId,
      operation: req.operation,
      trigger: req.trigger,
      waitMs,
      capMs,
    });
  }

  // Reserve first, then sleep. Committing the schedule at admission is what
  // gives each concurrent caller its own distinct wake time instead of ten
  // callers sleeping the same interval and waking together to fight over the
  // same tokens.
  writeTat(key, candidateTat, at);
  await sleep(waitMs);
  totalWaitedMs += waitMs;
  return { waitedMs: waitMs, units: req.units };
}

/**
 * Book quota for a call that is going to happen no matter what. Never waits,
 * never throws.
 *
 * FOR TRAFFIC WE DO NOT GET TO DECLINE — specifically the authentication
 * recovery path. Making that call queue behind a background sync would rebuild,
 * in slower motion, the deadlock gmail-request.ts exists to prevent: the token
 * refresh must never depend on the thing the refresh is meant to repair. But it
 * still spends real quota, so the budget has to know about it. Charging without
 * admitting is how both stay true at once.
 *
 * The transition is exactly `acquireQuota`'s `candidateTat`, committed with no
 * admission test. NOT a bare `tat += emissionMs`: on an idle bucket whose `tat`
 * sits in the past, a bare increment can leave it still in the past, and the
 * charge vanishes — under-counting precisely the traffic this function exists to
 * count.
 */
export function chargeQuota(req: Omit<QuotaRequest, "hooks"> & { hooks?: QuotaHooks }): void {
  if (!pacingEnabled) return;
  try {
    const now = req.hooks?.now ?? defaultNow;
    const at = now();
    const key = bucketKey(req);
    const baseTat = Math.max(readTat(key, at), at);
    writeTat(key, baseTat + req.units * MS_PER_UNIT, at);
  } catch {
    // Same rule as the ledger: this must never be able to fail a Gmail call.
  }
}

export interface QuotaLimiterSnapshot {
  buckets: number;
  pacedOut: number;
  totalWaitedMs: number;
  fallbackPriced: number;
  unitsPerSec: number;
  burstUnits: number;
  enabled: boolean;
}

export function quotaLimiterSnapshot(): QuotaLimiterSnapshot {
  return {
    buckets: buckets.size,
    pacedOut: pacedOutCount,
    totalWaitedMs,
    fallbackPriced: fallbackPricedCount,
    unitsPerSec: UNITS_PER_SEC,
    burstUnits: BURST_UNITS,
    enabled: pacingEnabled,
  };
}

/** Test seam — the bucket map and counters are process-global. */
export function __resetQuotaLimiter(): void {
  buckets.clear();
  refusalLogs.clear();
  sinceSweep = 0;
  pacedOutCount = 0;
  totalWaitedMs = 0;
  fallbackPricedCount = 0;
}

/**
 * Test seam. Pacing is opt-in via env, which would otherwise make the whole
 * algorithm untestable in a suite that does not set it. Never called by
 * production code.
 */
export function __setPacingEnabled(enabled: boolean): void {
  pacingEnabled = enabled;
}

/** Exposed so tests assert against the same numbers the module actually uses,
 *  rather than hardcoding 75/250 and passing when the defaults change. */
export const __config = {
  unitsPerSec: UNITS_PER_SEC,
  burstUnits: BURST_UNITS,
  msPerUnit: MS_PER_UNIT,
  interactiveToleranceUnits: INTERACTIVE_TOLERANCE_UNITS,
  backgroundToleranceUnits: BACKGROUND_TOLERANCE_UNITS,
  idleReapMs: IDLE_REAP_MS,
} as const;

logger.info("[GMAIL_PACING] configured", {
  enabled: PACING_ENABLED_AT_BOOT,
  unitsPerSec: UNITS_PER_SEC,
  burstUnits: BURST_UNITS,
  interactiveToleranceUnits: INTERACTIVE_TOLERANCE_UNITS,
  backgroundToleranceUnits: BACKGROUND_TOLERANCE_UNITS,
});
