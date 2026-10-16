import { listMembers } from "./members.ts";
import { resolveViewerScope } from "./scope.ts";
import { resolveCoverage, computeMetrics, computeAggregateMetrics } from "./metrics.ts";
import { normalizeOrgEmail } from "./scope-policy.ts";
import { getSlaPolicy } from "./sla.ts";
import {
  ON_TARGET_AT_OR_ABOVE,
  SLIPPING_AT_OR_ABOVE,
  adherenceStatus,
  defaultTrafficClass,
  withinTargetNeeded,
  type Adherence,
  type SlaPolicy,
} from "./sla-policy.ts";
import {
  exceptionsFor,
  recommendationsFor,
  type ExceptionFlag,
  type Recommendation,
} from "./exceptions-policy.ts";
import type { CoverageState } from "./metrics-policy.ts";
import type { AggregateMetrics, MemberMetrics, MetricWindow } from "./types.ts";

/**
 * Assembles what a viewer is allowed to see into one response.
 *
 * The shape is deliberate: `members` and `covered` are separate numbers, and
 * every person in scope appears in `rows` whether or not they have data. A
 * report that quietly drops the two people who have not connected shows a
 * manager three rows for a team of five and reads as a complete answer — which
 * is the failure this whole feature is built to avoid.
 */

export interface ReportRow {
  email: string;
  /** Account display name; NULL without an account. Only ever for someone already in scope. */
  name: string | null;
  managerEmail: string | null;
  coverage: CoverageState;
  /** NULL for anyone not covered — absent data, not zero. */
  metrics: MemberMetrics | null;
  /**
   * How this person is doing against the response target, with the numbers
   * behind it. `NOT_COVERED` when there are no numbers at all — a coverage
   * state and an adherence state are different things, combined only here.
   */
  status: {
    status: Adherence["status"] | "NOT_COVERED";
    reason: string;
    /**
     * How many more threads answered within target would have reached
     * ON_TARGET this period. From `withinTargetNeeded`, never recomputed by a
     * client; null when on target, unmeasured or not covered.
     */
    withinTargetNeeded: number | null;
  };
  /** Everything outside target, each carrying its own evidence. Never summed. */
  exceptions: ExceptionFlag[];
  /** One line per exception, same order — `recommendationsFor(exceptions)`. */
  recommendations: Recommendation[];
}

/** What a response target is, travelling with the numbers it judges. */
export interface ReportPolicy {
  trafficClass: { id: string; label: string };
  firstResponseTargetSeconds: number;
  staleAfterSeconds: number;
  /**
   * The status boundaries, inclusive, as shares of the cohort. Configuration,
   * not a measurement of anyone — shipped so a screen drawing the goal line
   * never hardcodes a number the server might change.
   */
  onTargetAtOrAbove: number;
  slippingAtOrAbove: number;
}

export interface OrganizationReport {
  window: { from: string; to: string };
  /** Everyone in the viewer's scope. */
  members: number;
  /** How many of them could actually be measured. Aggregates use this. */
  covered: number;
  rows: ReportRow[];
  /** Shipped once, not per row: repeating a constant invites varying it. */
  policy: ReportPolicy;
}

function describePolicy(policy: SlaPolicy): ReportPolicy {
  const klass = defaultTrafficClass(policy);
  return {
    trafficClass: { id: klass.id, label: klass.label },
    firstResponseTargetSeconds: klass.target.firstResponseSeconds,
    staleAfterSeconds: klass.target.staleAfterSeconds,
    onTargetAtOrAbove: ON_TARGET_AT_OR_ABOVE,
    slippingAtOrAbove: SLIPPING_AT_OR_ABOVE,
  };
}

/**
 * Coverage first, adherence second.
 *
 * Somebody we cannot measure is not off target — they are unmeasured, and
 * saying otherwise puts a red badge on a person whose only fault is not having
 * connected a mailbox.
 */
function statusFor(
  metrics: MemberMetrics | AggregateMetrics | null,
  coverage: CoverageState,
  policy: SlaPolicy,
): ReportRow["status"] {
  if (coverage !== "COVERED" || !metrics) {
    return {
      status: "NOT_COVERED",
      reason: "This mailbox is not connected to Mailroid",
      withinTargetNeeded: null,
    };
  }
  const counts = {
    threadsRespondable: metrics.threadsRespondable,
    threadsAnsweredWithinTarget: metrics.threadsAnsweredWithinTarget,
    target: defaultTrafficClass(policy).target,
  };
  return { ...adherenceStatus(counts), withinTargetNeeded: withinTargetNeeded(counts) };
}

export async function buildReport(input: {
  organizationId: string;
  viewerEmail: string;
  window: MetricWindow;
  /** Restrict to one person — used by the employee self-view. */
  onlyEmail?: string;
}): Promise<OrganizationReport | null> {
  const scope = await resolveViewerScope(input.organizationId, input.viewerEmail);
  if (!scope) return null;

  let emails = scope.visibleEmails;
  if (input.onlyEmail) {
    const only = normalizeOrgEmail(input.onlyEmail);
    // Scope is still the authority even for a single-person request: asking for
    // a specific colleague must be refused, not silently emptied.
    if (!emails.includes(only)) return null;
    emails = [only];
  }

  const [allMembers, coverage, policy] = await Promise.all([
    listMembers(input.organizationId),
    resolveCoverage(emails),
    getSlaPolicy(input.organizationId),
  ]);

  const metrics = await computeMetrics(coverage, input.window, {
    target: defaultTrafficClass(policy).target,
    asOf: input.window.to,
  });
  const managerOf = new Map(allMembers.map((m) => [m.email, m.managerEmail]));

  const rows: ReportRow[] = coverage.map((c) => {
    const row = metrics.get(c.email) ?? null;
    const exceptions = exceptionsFor({ metrics: row, coverage: c.state }, policy);
    return {
      email: c.email,
      name: c.name,
      managerEmail: managerOf.get(c.email) ?? null,
      coverage: c.state,
      metrics: row,
      status: statusFor(row, c.state, policy),
      exceptions,
      // Paired here, per row and per period. The drill-down used to borrow the
      // daily summary's advice, which describes a different window.
      recommendations: recommendationsFor(exceptions),
    };
  });

  rows.sort((a, b) => a.email.localeCompare(b.email));

  return {
    window: { from: input.window.from.toISOString(), to: input.window.to.toISOString() },
    members: rows.length,
    covered: rows.filter((r) => r.coverage === "COVERED").length,
    rows,
    policy: describePolicy(policy),
  };
}

/** Only these periods are offered anywhere in the product. */
export type PeriodDays = 7 | 30 | 90;

/** A reporting window of the given length, trailing up to `now`. */
export function windowForDays(days: PeriodDays, now = new Date()): MetricWindow {
  return { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), to: now };
}

/** Default reporting period: the trailing 30 days. */
export function defaultWindow(now = new Date()): MetricWindow {
  return windowForDays(30, now);
}

/** The window of the same length immediately preceding this one. */
export function previousWindow(window: MetricWindow): MetricWindow {
  const durationMs = window.to.getTime() - window.from.getTime();
  return {
    from: new Date(window.from.getTime() - durationMs),
    to: window.from,
  };
}

/**
 * The only place the period→bucket-size mapping lives. Bucket size is fixed
 * per period, never client-supplied — a trend request only ever carries
 * `days`, so there is no field anywhere in the public contract that could
 * ask for an arbitrarily large bucket count.
 */
export function bucketSizeDaysForPeriod(days: PeriodDays): number {
  return days === 7 ? 1 : 7;
}

/**
 * Splits a window into fixed-size slices, most-recent-last. The final slice
 * is clipped to `window.to` rather than overshooting it, so it may be
 * shorter than `bucketSizeDays` — never longer, and never gapped.
 */
export function bucketWindow(window: MetricWindow, bucketSizeDays: number): MetricWindow[] {
  const bucketMs = bucketSizeDays * 24 * 60 * 60 * 1000;
  const buckets: MetricWindow[] = [];
  let from = window.from.getTime();
  const end = window.to.getTime();
  while (from < end) {
    const to = Math.min(from + bucketMs, end);
    buckets.push({ from: new Date(from), to: new Date(to) });
    from = to;
  }
  return buckets;
}

/**
 * A bucket carries only what is meaningful about a closed period.
 *
 * The point-in-time fields are deliberately absent. "Still waiting" is a fact
 * about *now*: in a bucket that closed three weeks ago, a thread answered the
 * day after it closed is invisible as answered and counts as waiting forever.
 * The chart would draw a rising backlog that is pure bucketing artifact and
 * never falls when the team actually clears it.
 *
 * Within-target survives because the reply is unbounded by the bucket's end, so
 * "answered within 4h" is stable for a historical cohort in the way "waiting"
 * is not.
 */
export interface TrendBucket
  extends Omit<
    AggregateMetrics,
    "threadsAwaitingReply" | "threadsOverdue" | "threadsStale" | "oldestWaitingSeconds"
  > {
  from: string;
  to: string;
}

/**
 * Buckets computed at once. Four, not thirteen: an unbounded Promise.all over a
 * 90-day trend opens 26 concurrent statements against one pool, which is how
 * one person's page load starves every other request on the box.
 *
 * The real fix is a single query bucketing with date_trunc/width_bucket and
 * grouping by bucket, which removes the loop entirely. That is a rewrite of
 * both CTEs and has not been done.
 */
const TREND_CONCURRENCY = 4;

/**
 * Resolves the same authorization/scope a report would, then computes one
 * aggregate per bucket instead of one report row per person. `excludeViewer`
 * drops the viewer's own mailbox from every bucket's total — used when this
 * is a team/org aggregate sitting next to the viewer's own "My" numbers, so
 * the two never double-count the same mail.
 */
export async function buildTrend(input: {
  organizationId: string;
  viewerEmail: string;
  window: MetricWindow;
  days: PeriodDays;
  onlyEmail?: string;
  excludeViewer?: boolean;
}): Promise<TrendBucket[] | null> {
  const scope = await resolveViewerScope(input.organizationId, input.viewerEmail);
  if (!scope) return null;

  let emails = scope.visibleEmails;
  if (input.onlyEmail) {
    const only = normalizeOrgEmail(input.onlyEmail);
    if (!emails.includes(only)) return null;
    emails = [only];
  }
  if (input.excludeViewer) {
    const viewer = normalizeOrgEmail(input.viewerEmail);
    emails = emails.filter((e) => e !== viewer);
  }

  const [coverage, policy] = await Promise.all([
    resolveCoverage(emails),
    getSlaPolicy(input.organizationId),
  ]);
  const userIds = coverage.filter((c) => c.state === "COVERED").map((c) => c.userId!);
  const target = defaultTrafficClass(policy).target;

  const bucketSizeDays = bucketSizeDaysForPeriod(input.days);
  const buckets = bucketWindow(input.window, bucketSizeDays);

  const results: TrendBucket[] = [];
  for (let start = 0; start < buckets.length; start += TREND_CONCURRENCY) {
    const chunk = buckets.slice(start, start + TREND_CONCURRENCY);
    const aggregates = await Promise.all(
      chunk.map((bucket) =>
        // Skipping the waiting query is not only a saving — see TrendBucket for
        // why those numbers are meaningless in a closed bucket.
        computeAggregateMetrics(userIds, bucket, {
          target,
          asOf: bucket.to,
          includePointInTime: false,
        }),
      ),
    );
    for (const [index, aggregate] of aggregates.entries()) {
      const bucket = chunk[index]!;
      results.push({
        from: bucket.from.toISOString(),
        to: bucket.to.toISOString(),
        received: aggregate.received,
        sent: aggregate.sent,
        medianResponseSeconds: aggregate.medianResponseSeconds,
        threadsRespondable: aggregate.threadsRespondable,
        threadsAnswered: aggregate.threadsAnswered,
        threadsAnsweredWithinTarget: aggregate.threadsAnsweredWithinTarget,
      });
    }
  }
  return results;
}

/**
 * The same aggregate, for the current window and the one immediately before
 * it — a plain, literal comparison ("39 received, 34 previous period"),
 * never a percentage framed as a grade. Same scope/authorization and
 * `excludeViewer` rules as `buildTrend`.
 */
export async function buildComparison(input: {
  organizationId: string;
  viewerEmail: string;
  window: MetricWindow;
  onlyEmail?: string;
  excludeViewer?: boolean;
}): Promise<{ current: AggregateMetrics; previous: AggregateMetrics } | null> {
  const scope = await resolveViewerScope(input.organizationId, input.viewerEmail);
  if (!scope) return null;

  let emails = scope.visibleEmails;
  if (input.onlyEmail) {
    const only = normalizeOrgEmail(input.onlyEmail);
    if (!emails.includes(only)) return null;
    emails = [only];
  }
  if (input.excludeViewer) {
    const viewer = normalizeOrgEmail(input.viewerEmail);
    emails = emails.filter((e) => e !== viewer);
  }

  const [coverage, policy] = await Promise.all([
    resolveCoverage(emails),
    getSlaPolicy(input.organizationId),
  ]);
  const userIds = coverage.filter((c) => c.state === "COVERED").map((c) => c.userId!);
  const target = defaultTrafficClass(policy).target;
  const prior = previousWindow(input.window);

  const [current, previous] = await Promise.all([
    computeAggregateMetrics(userIds, input.window, { target, asOf: input.window.to }),
    computeAggregateMetrics(userIds, prior, { target, asOf: prior.to }),
  ]);

  return { current, previous };
}

/**
 * The trailing 24 hours.
 *
 * Deliberately not a fourth value in `PeriodDays`: that type is the input to
 * report, trend and the period selector, so adding `1` would put a one-day
 * option in every dropdown in the product and make a single-bucket trend chart
 * reachable. This is a different question, so it gets a different window.
 */
export function dailyWindow(now = new Date()): MetricWindow {
  return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000), to: now };
}

/**
 * How far back open items are looked for.
 *
 * A 24-hour query cannot see a reply sent two days ago and would report every
 * older thread as still waiting, so open items need their own, wider window.
 *
 * This bound is real and it travels with the numbers: a thread waiting 120 days
 * is invisible here, so "oldest waiting" means "oldest within this lookback"
 * and every screen that renders it has to say so. Widening it moves the cliff
 * rather than removing it; the actual fix is an unbounded open-threads query,
 * which is a different query shape and has not been built.
 */
export const OPEN_ITEMS_LOOKBACK_DAYS = 90;

export interface DailySummary {
  window: { from: string; to: string };
  /** The last 24 hours. */
  activity: Omit<
    AggregateMetrics,
    "threadsAwaitingReply" | "threadsOverdue" | "threadsStale" | "oldestWaitingSeconds"
  >;
  /**
   * Right now — NOT 24-hour scoped. A thread that has been waiting nine days is
   * the most important thing on this card, and clipping it to a day would hide
   * exactly that. The two clocks are separate fields because they are separate
   * questions, and the UI must label them separately.
   */
  openItems: {
    threadsAwaitingReply: number;
    threadsOverdue: number;
    threadsStale: number;
    oldestWaitingSeconds: number | null;
    lookbackDays: number;
  };
  exceptions: ExceptionFlag[];
  recommendations: Recommendation[];
  policy: ReportPolicy;
}

export async function buildDailySummary(input: {
  organizationId: string;
  viewerEmail: string;
  onlyEmail?: string;
  excludeViewer?: boolean;
  now?: Date;
}): Promise<DailySummary | null> {
  const scope = await resolveViewerScope(input.organizationId, input.viewerEmail);
  if (!scope) return null;

  let emails = scope.visibleEmails;
  if (input.onlyEmail) {
    const only = normalizeOrgEmail(input.onlyEmail);
    if (!emails.includes(only)) return null;
    emails = [only];
  }
  if (input.excludeViewer) {
    const viewer = normalizeOrgEmail(input.viewerEmail);
    emails = emails.filter((e) => e !== viewer);
  }

  const now = input.now ?? new Date();
  const [coverage, policy] = await Promise.all([
    resolveCoverage(emails),
    getSlaPolicy(input.organizationId),
  ]);
  const userIds = coverage.filter((c) => c.state === "COVERED").map((c) => c.userId!);
  const target = defaultTrafficClass(policy).target;

  const day = dailyWindow(now);
  const lookback: MetricWindow = {
    from: new Date(now.getTime() - OPEN_ITEMS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    to: now,
  };

  const [activity, open] = await Promise.all([
    computeAggregateMetrics(userIds, day, { target, asOf: day.to, includePointInTime: false }),
    computeAggregateMetrics(userIds, lookback, { target, asOf: now }),
  ]);

  // Exceptions read the open-items window, not the day: "3 threads past target"
  // is a statement about what is open now, and computing it from 24 hours of
  // mail would quietly drop everything older than yesterday.
  const flags = exceptionsFor(
    { metrics: open, coverage: userIds.length > 0 ? "COVERED" : "NO_ACCOUNT" },
    policy,
  );

  return {
    window: { from: day.from.toISOString(), to: day.to.toISOString() },
    activity: {
      received: activity.received,
      sent: activity.sent,
      medianResponseSeconds: activity.medianResponseSeconds,
      threadsRespondable: activity.threadsRespondable,
      threadsAnswered: activity.threadsAnswered,
      threadsAnsweredWithinTarget: activity.threadsAnsweredWithinTarget,
    },
    openItems: {
      threadsAwaitingReply: open.threadsAwaitingReply,
      threadsOverdue: open.threadsOverdue,
      threadsStale: open.threadsStale,
      oldestWaitingSeconds: open.oldestWaitingSeconds,
      lookbackDays: OPEN_ITEMS_LOOKBACK_DAYS,
    },
    exceptions: flags,
    recommendations: recommendationsFor(flags),
    policy: describePolicy(policy),
  };
}
