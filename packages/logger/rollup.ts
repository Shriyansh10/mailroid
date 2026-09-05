/**
 * Success summarisation — the other half of "an error is a document, a success
 * is a statistic".
 *
 * `error-fields.ts` handles the first half: one error, one complete line, never
 * aggregated. This module handles the second: a hundred successes become one
 * line saying a hundred things went fine and for how long.
 *
 * IT EXISTS BECAUSE OF THE ARITHMETIC. A six-hour incident produced 56,863
 * Gmail requests. Logging one line per successful call would have written 56,863
 * lines — an unreadable file locally, and an incident-shaped spike against a
 * 50 GB/month free tier once these lines ship to a vendor. Logging *nothing* per
 * successful call is what made the incident undiagnosable in the first place.
 * The resolution is neither: aggregate in memory, emit on an escalating ladder.
 *
 * An hour of healthy traffic costs roughly four lines, at t+1m, t+6m, t+21m and
 * t+81m, each one covering everything since the last. An hour with a failure in
 * it costs those plus one complete error line at the call site plus one
 * "recovered" line — and the ladder drops back to a minute, so the period around
 * a failure is described in detail and the quiet hours are not.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO:
 *
 *   - It does not emit errors. The call site does, with `errorFields(err)` and
 *     the context only it has (`operation`, `attempt`, `correlationId`). Passing
 *     an error in here to be formatted would mean widening `failure()` to carry
 *     every call-site field, and fields get dropped on the way in. `failure()`
 *     takes no error on purpose: its job is to reset the ladder and arm the
 *     "recovered" line, not to describe what went wrong.
 *   - It does not import the logger. `pii.ts` states the reason and it applies
 *     here too — this module is imported by the logger's own consumers, so an
 *     import of `./index.ts` would be a cycle. The emit function is injected,
 *     which is also what makes this testable without winston or a filesystem.
 *   - It is not Gmail-specific. The Gmail call ledger is the first caller, not
 *     the only possible one, so the tag is a parameter.
 *
 * IT MUST NEVER BREAK A REQUEST PATH. Every public method swallows its own
 * failures. A diagnostic that can throw into the code it is measuring is worse
 * than no diagnostic, and this one runs on the hot path of every Gmail call.
 */

/** The escalation ladder: 1m → 5m → 15m → 1h. A window that closes healthy
 *  steps one rung up, so a system that stays quiet gets quieter. Any failure
 *  drops it back to the first rung. */
const LADDER_MS = [60_000, 300_000, 900_000, 3_600_000] as const;

/** How often the timer looks for windows to close. The shortest rung, because
 *  a window can never close sooner than that. */
const TICK_MS = LADDER_MS[0];

/**
 * Distinct (tenant, trigger, operation) keys held before overflow folds into a
 * single `other` bucket.
 *
 * ALLOCATION MUST BE BOUNDED. The scenario this module is built for is a storm,
 * and a storm is exactly when an unbounded Map turns a diagnostic into a second
 * outage. Overflow is counted and reported rather than dropped silently — an
 * `other` bucket with a large count is itself a finding.
 */
const MAX_KEYS = 200;

/**
 * Durations kept per window for the p50, most recent first out.
 *
 * A percentile over a bounded sample, not over every call — 56k durations in an
 * array is the allocation problem again. The reported p50 is honest about this:
 * it is the median of the last 128 calls in the window, which for a health line
 * is the question being asked anyway.
 */
const DURATION_SAMPLES = 128;

export type RollupLevel = "info" | "debug";

/** Where a finished summary goes. Injected, so this module stays logger-free. */
export interface RollupEmit {
  (level: RollupLevel, message: string, meta: Record<string, unknown>): void;
}

/**
 * What a summary is grouped by.
 *
 * `tenantId`, never a mailbox address — the internal id is the join key that
 * makes attribution work and is meaningless outside our own database. Where
 * mailbox identity is genuinely the question, the caller hashes it first with
 * `hashMailbox` and passes the digest.
 */
export interface RollupKey {
  tenantId: string;
  trigger: string;
  operation: string;
}

/** One call's contribution. Everything is optional but `logical_calls`, because
 *  a caller that knows only "something happened" is still worth counting. */
export interface RollupSample {
  /**
   * What actually went to Google, when that differs from what the caller asked
   * for. THE PAIR IS THE POINT: `attachments.get x5` for one click cannot show
   * amplification, while `calls=1 attempts=5 retries=4` states it outright.
   */
  attempts?: number;
  /** Quota cost, where it is known. Optional on purpose — see `quotaUnknown`. */
  quotaUnits?: number;
  durationMs?: number;
  /**
   * Time this call spent waiting on a client-side rate limiter before any bytes
   * left the process.
   *
   * SEPARATE FROM `durationMs`, NOT FOLDED INTO IT. They answer opposite
   * questions — `durationMs` is "how slow is the upstream", `waitedMs` is "how
   * hard are we throttling ourselves". Summing them makes a correctly-paced call
   * indistinguishable from a slow one, and the natural response to that reading
   * is to raise the rate limit, which is exactly backwards.
   */
  waitedMs?: number;
  /**
   * Response bytes for this call, where measurable. Optional and additive:
   * a caller that never reports it (every consumer before P-5c,
   * docs/gmail-rate-limit-boundary.md §13) gets a summary line shaped exactly
   * as before — `bytes` is omitted from the emitted line when the window's
   * total is zero, same convention as `waitedMs`.
   */
  bytes?: number;
}

export interface Rollup {
  /** Record a successful call. Also emits "recovered" on the first success
   *  after a failure. */
  success(key: RollupKey, sample?: RollupSample): void;
  /**
   * Record a failure. Resets the ladder to 1m and arms "recovered". The
   * complete error line is still the call site's job, not this one's.
   *
   * TAKES THE SAME SAMPLE AS `success`, AND MUST. It did not, once, and a
   * failed call therefore reached `errors` without ever reaching `calls` or
   * `attempts` — so a window holding nothing but failures reported
   * `calls: 0 attempts: 0 errors: 1`, which reads as "no traffic" for a request
   * that really did go to Google and really did come back 429.
   *
   * That is not a cosmetic undercount. `attempts` vs `calls` is the pair the
   * runbook uses to prove or falsify H-C (retry x recovery multiplication) —
   * a fault whose entire signature is *many failing attempts per logical call*.
   * Dropping the sample on the failure path blinded the one measurement built
   * to see it, in precisely the conditions where it matters: a quota incident
   * is mostly failures by definition.
   */
  failure(key: RollupKey, sample?: RollupSample): void;
  /** Close every window that is due. Called by the timer; exposed for tests
   *  and for a shutdown flush. */
  tick(): void;
  /** Emit everything currently held, regardless of window. For shutdown. */
  flush(): void;
  /** Stop the timer. Idempotent. */
  stop(): void;
}

export interface RollupOptions {
  /** Prefix on the emitted message, e.g. "[GMAIL_HEALTH]". */
  tag: string;
  emit: RollupEmit;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Ladder override, for tests. */
  ladderMs?: readonly number[];
  /** Set false in tests so no timer is created. */
  autoStart?: boolean;
  maxKeys?: number;
}

interface Bucket {
  key: RollupKey;
  /** What callers asked for. */
  calls: number;
  /** What went to the network. Falls back to `calls` when unreported. */
  attempts: number;
  errors: number;
  quotaUnits: number;
  /** Calls whose unit cost is not known. Reported, never guessed: quota units
   *  and request counts are different measurements and a fabricated cost is
   *  worse than an absent one. */
  quotaUnknown: number;
  durations: number[];
  durationMax: number;
  /** Summed client-side pacing wait, and the worst single wait, over the window.
   *  A total answers "how much throughput did pacing cost"; the max answers "did
   *  any one call stall badly", and a mean would hide both. */
  waitedTotalMs: number;
  waitedMaxMs: number;
  /** P-5c byte meter. Summed only — no per-call max; a byte count has no
   *  equivalent of "did one call stall badly", so there is nothing a max
   *  would tell a reader that the total doesn't already. */
  bytes: number;
  /** Wall-clock start of the window now accumulating. */
  windowStartedAt: number;
  /** Rung of LADDER_MS this key is on. */
  rung: number;
  /** When the current healthy run began — reset by a failure, and the source of
   *  the "ok 1h04m" figure. */
  healthySince: number;
  /** Set by failure(), cleared by the "recovered" line. */
  failingSince: number | null;
  /** Failures accumulated since the last "recovered". */
  failuresInOutage: number;
  lastErrorAt: number | null;
  /** Windows folded into the next emission rather than emitted on their own. */
  suppressed: number;
}

function keyOf(key: RollupKey): string {
  return `${key.tenantId} ${key.trigger} ${key.operation}`;
}

/** Human-readable elapsed time: "45s", "6m", "1h04m". Grep-able in the message
 *  while the exact millisecond value stays in the structured fields. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

/** Median of a bounded sample. Undefined rather than 0 when nothing was
 *  measured — a p50 of zero reads as "instant", which is a lie. */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

export function createRollup(options: RollupOptions): Rollup {
  const {
    tag,
    emit,
    now = () => Date.now(),
    ladderMs = LADDER_MS,
    autoStart = true,
    maxKeys = MAX_KEYS,
  } = options;

  const buckets = new Map<string, Bucket>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const OVERFLOW: RollupKey = {
    tenantId: "other",
    trigger: "other",
    operation: "other",
  };

  function bucketFor(key: RollupKey): Bucket {
    const id = keyOf(key);
    const existing = buckets.get(id);
    if (existing) return existing;

    // Overflow folds into one shared bucket rather than evicting an existing
    // key. Evicting would lose the healthy-streak and outage state that the
    // "ok"/"recovered" lines depend on, and under a storm it would evict
    // precisely the busiest key.
    if (buckets.size >= maxKeys) {
      const overflowId = keyOf(OVERFLOW);
      const overflow = buckets.get(overflowId);
      if (overflow) return overflow;
      const created = freshBucket(OVERFLOW, now());
      buckets.set(overflowId, created);
      return created;
    }

    const created = freshBucket(key, now());
    buckets.set(id, created);
    return created;
  }

  function freshBucket(key: RollupKey, at: number): Bucket {
    return {
      key,
      calls: 0,
      attempts: 0,
      errors: 0,
      quotaUnits: 0,
      quotaUnknown: 0,
      durations: [],
      durationMax: 0,
      waitedTotalMs: 0,
      waitedMaxMs: 0,
      bytes: 0,
      windowStartedAt: at,
      rung: 0,
      healthySince: at,
      failingSince: null,
      failuresInOutage: 0,
      lastErrorAt: null,
      suppressed: 0,
    };
  }

  /** Zero the counters, keep the health state. Called after every emission. */
  function resetCounters(bucket: Bucket, at: number): void {
    bucket.calls = 0;
    bucket.attempts = 0;
    bucket.errors = 0;
    bucket.quotaUnits = 0;
    bucket.quotaUnknown = 0;
    bucket.durations = [];
    bucket.durationMax = 0;
    bucket.waitedTotalMs = 0;
    bucket.waitedMaxMs = 0;
    bucket.bytes = 0;
    bucket.windowStartedAt = at;
  }

  function safeEmit(
    level: RollupLevel,
    message: string,
    meta: Record<string, unknown>,
  ): void {
    try {
      emit(level, message, meta);
    } catch {
      // A logger that throws while describing healthy traffic must not be the
      // reason a request fails. There is nowhere useful to report this to —
      // the reporting mechanism is what just failed.
    }
  }

  /**
   * Fold one call's sample into its bucket.
   *
   * Shared by success() and failure() so the two can never drift apart again —
   * they did, and the failure path silently dropped every field but the error
   * count. A success and a failure differ in exactly one way, `errors`, and
   * that difference belongs at the call site rather than in two copies of this
   * arithmetic.
   */
  function accumulate(bucket: Bucket, sample?: RollupSample): void {
    bucket.calls += 1;
    bucket.attempts += sample?.attempts ?? 1;

    if (typeof sample?.quotaUnits === "number") {
      bucket.quotaUnits += sample.quotaUnits;
    } else {
      bucket.quotaUnknown += 1;
    }

    if (typeof sample?.durationMs === "number") {
      if (bucket.durations.length >= DURATION_SAMPLES) bucket.durations.shift();
      bucket.durations.push(sample.durationMs);
      if (sample.durationMs > bucket.durationMax) {
        bucket.durationMax = sample.durationMs;
      }
    }

    if (typeof sample?.waitedMs === "number") {
      bucket.waitedTotalMs += sample.waitedMs;
      if (sample.waitedMs > bucket.waitedMaxMs) {
        bucket.waitedMaxMs = sample.waitedMs;
      }
    }

    if (typeof sample?.bytes === "number") {
      bucket.bytes += sample.bytes;
    }
  }

  function emitSummary(bucket: Bucket, at: number): void {
    const windowMs = at - bucket.windowStartedAt;
    const failingSince = bucket.failingSince;
    const healthyFor = failingSince === null ? at - bucket.healthySince : 0;
    const degradedFor = failingSince === null ? 0 : at - failingSince;

    /**
     * THE WORD "ok" MUST NEVER APPEAR ON A FAILING WINDOW.
     *
     * This used to be `ok ${formatDuration(healthyFor)}` unconditionally, and
     * `healthyFor` is defined as 0 while a bucket is failing — so an outage
     * emitted the line `[GMAIL_LEDGER] ok 0s` with `errors: 1` beside it. It is
     * technically honest ("healthy for zero seconds") and completely misleading:
     * anyone scanning for trouble reads "ok" and moves on, which is the exact
     * failure this whole branch exists to remove. An error is a document; a
     * summary that hides one is worse than no summary.
     */
    const label =
      failingSince === null
        ? `ok ${formatDuration(healthyFor)}`
        : `degraded ${formatDuration(degradedFor)}, ${bucket.errors} error${bucket.errors === 1 ? "" : "s"}`;

    safeEmit("info", `${tag} ${label}`, {
      tenantId: bucket.key.tenantId,
      trigger: bucket.key.trigger,
      operation: bucket.key.operation,
      windowMs,
      // The names mirror the ledger schema in the runbook: what the caller
      // asked for vs what reached Google, and the difference between them.
      calls: bucket.calls,
      attempts: bucket.attempts,
      retries: Math.max(0, bucket.attempts - bucket.calls),
      errors: bucket.errors,
      quotaUnits: bucket.quotaUnits,
      quotaUnknown: bucket.quotaUnknown,
      durationP50Ms: median(bucket.durations),
      durationMaxMs: bucket.durationMax || undefined,
      // Omitted entirely when nothing waited, so an unpaced deployment's lines
      // look exactly as they did before this field existed.
      waitedTotalMs: bucket.waitedTotalMs || undefined,
      waitedMaxMs: bucket.waitedMaxMs || undefined,
      // P-5c: omitted when zero, same convention as waitedMs above — a
      // window with no bytes reported (i.e. every consumer before the meter
      // existed) keeps the exact line shape it always had.
      bytes: bucket.bytes || undefined,
      healthyForMs: healthyFor,
      // Mirrors healthyForMs so a degraded window is filterable structurally,
      // not only by reading the message. Omitted when healthy, so a healthy
      // line keeps the shape it had before this field existed.
      degradedForMs: degradedFor || undefined,
      // Windows folded into this line rather than emitted separately. A reader
      // seeing calls=412 over windowMs=900000 should know it is not a gap.
      suppressedWindows: bucket.suppressed,
      lastErrorAgoMs:
        bucket.lastErrorAt === null ? undefined : at - bucket.lastErrorAt,
    });

    bucket.suppressed = 0;
    resetCounters(bucket, at);
  }

  function emitRecovered(bucket: Bucket, at: number): void {
    const downtimeMs = bucket.failingSince === null ? 0 : at - bucket.failingSince;

    safeEmit("info", `${tag} recovered after ${formatDuration(downtimeMs)}`, {
      tenantId: bucket.key.tenantId,
      trigger: bucket.key.trigger,
      operation: bucket.key.operation,
      downtimeMs,
      failures: bucket.failuresInOutage,
    });
  }

  function closeDueWindows(at: number, force: boolean): void {
    for (const bucket of buckets.values()) {
      const windowLength = ladderMs[Math.min(bucket.rung, ladderMs.length - 1)]!;
      const elapsed = at - bucket.windowStartedAt;
      if (!force && elapsed < windowLength) continue;

      // An idle key says nothing. Emitting "calls=0" every minute for a tenant
      // that is simply not being used is the noise this module exists to
      // prevent, and it would drown the keys that are actually moving.
      if (bucket.calls === 0 && bucket.errors === 0) {
        bucket.windowStartedAt = at;
        continue;
      }

      emitSummary(bucket, at);

      // Step up only on a clean window. A window carrying errors keeps the
      // ladder where failure() put it, so the minutes after a fault stay
      // described at one-minute resolution.
      if (bucket.errors === 0 && bucket.failingSince === null) {
        bucket.rung = Math.min(bucket.rung + 1, ladderMs.length - 1);
        bucket.suppressed += 1;
      }
    }
  }

  const rollup: Rollup = {
    success(key, sample) {
      try {
        const at = now();
        const bucket = bucketFor(key);

        if (bucket.failingSince !== null) {
          // The state change is the story: a mailbox that starts working again
          // is worth a line, and it is the only place downtime can be measured.
          emitRecovered(bucket, at);
          bucket.failingSince = null;
          bucket.failuresInOutage = 0;
          bucket.healthySince = at;
        }

        accumulate(bucket, sample);
      } catch {
        // See safeEmit.
      }
    },

    failure(key, sample) {
      try {
        const at = now();
        const bucket = bucketFor(key);

        // Identical accounting to success(). A call that failed is still a call
        // the caller made and still bytes that went to Google; only `errors`
        // distinguishes it. See the note on Rollup.failure.
        accumulate(bucket, sample);

        bucket.errors += 1;
        bucket.lastErrorAt = at;
        bucket.failuresInOutage += 1;
        if (bucket.failingSince === null) bucket.failingSince = at;

        // Back to the bottom rung. The window around a failure is the one worth
        // describing, and an hour-long window would report it long after it
        // stopped being actionable.
        bucket.rung = 0;
      } catch {
        // See safeEmit.
      }
    },

    tick() {
      try {
        closeDueWindows(now(), false);
      } catch {
        // See safeEmit.
      }
    },

    flush() {
      try {
        closeDueWindows(now(), true);
      } catch {
        // See safeEmit.
      }
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  if (autoStart) {
    timer = setInterval(() => rollup.tick(), TICK_MS);
    // unref, so an idle summariser never keeps a process alive. A CLI or a test
    // runner that has finished its work must be allowed to exit, and a
    // diagnostic timer is not a reason to hang.
    timer.unref?.();
  }

  return rollup;
}
