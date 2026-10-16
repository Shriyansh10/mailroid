/**
 * What is outside target, why, and what to do about it. No IO.
 *
 * ── Why this is a pure function and not SQL ──
 *
 * Thresholds in query text would live in three places — the per-member query,
 * the aggregate query, and any future roll-up — and one of them will be edited
 * without the others, which makes the People table disagree with the Overview
 * card by an amount nobody can explain. The reason strings are product copy,
 * which does not belong in Postgres where no reviewer looks for it. And this
 * service has no database test harness, so a judgement encoded in SQL is a
 * judgement that ships untested. Every input here is already a column on the
 * row, so none of that costs anything.
 *
 * ── What is deliberately absent ──
 *
 * Nothing weighs or combines flags: no total, no weighted sum, no derived
 * grade, no sort key computed from how many a person has. Displaying the counts
 * a flag already carries is expected — `3 overdue` is an operational fact and
 * belongs on screen. The forbidden thing is aggregation into a single figure
 * about a person, because a single figure sorted descending is a leaderboard.
 */

import type { CoverageState } from "./metrics-policy.ts";
import {
  PENDING_BACKLOG_THREADS,
  formatTargetHours,
  type SlaPolicy,
  type TrafficClassId,
} from "./sla-policy.ts";
import type { AggregateMetrics, MemberMetrics } from "./types.ts";

/**
 * Note what is NOT here: OLDEST_WAITING.
 *
 * Every person with one waiting thread has an oldest one, so that flag fires on
 * a perfectly healthy row and turns "oldest wait: 2h" into something that reads
 * as a problem. `oldestWaitingSeconds` is a metric with its own column; the case
 * where it actually matters — an oldest wait past the target — is already
 * exactly OVERDUE_WAITING. A flag that fires on everyone gets ignored, and it
 * drags the genuine ones down with it.
 */
export type ExceptionKind =
  | "ANSWERED_LATE"
  | "UNANSWERED"
  | "OVERDUE_WAITING"
  | "STALE_WAITING"
  | "PENDING_BACKLOG"
  | "NOT_COVERED";

/**
 * INFO  — operational context. Load or coverage, not a missed target.
 * WATCH — a target was missed on something already concluded. Nothing to do now.
 * ACT   — something is waiting, past target, right now. Clearable today.
 */
export type ExceptionSeverity = "INFO" | "WATCH" | "ACT";

export interface ExceptionFlag {
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  /** Product English with the numbers inlined. The only thing the UI renders. */
  reason: string;
  /** The measured value behind the flag. */
  observed: number;
  /** The threshold it crossed. */
  threshold: number;
  unit: "THREADS" | "SECONDS";
  trafficClass: TrafficClassId;
}

export interface Recommendation {
  forKind: ExceptionKind;
  text: string;
}

/**
 * Fixed order, so the same row always produces byte-identical output. A list
 * whose order wobbles between two renders of the same data reads as a bug even
 * when every entry is correct.
 */
const KIND_ORDER: readonly ExceptionKind[] = [
  "NOT_COVERED",
  "STALE_WAITING",
  "OVERDUE_WAITING",
  "UNANSWERED",
  "ANSWERED_LATE",
  "PENDING_BACKLOG",
];

const SEVERITY: Record<ExceptionKind, ExceptionSeverity> = {
  NOT_COVERED: "INFO",
  STALE_WAITING: "ACT",
  OVERDUE_WAITING: "ACT",
  UNANSWERED: "WATCH",
  ANSWERED_LATE: "WATCH",
  // Load, not a missed target: ten waiting threads is nothing for a support
  // inbox and a lot for a finance lead, and this number cannot know which.
  PENDING_BACKLOG: "INFO",
};

/**
 * One deterministic line per kind. No model, no template beyond the numbers the
 * flag already carries — a recommendation that cannot be predicted from the
 * data cannot be defended when the person it describes asks about it.
 */
const RECOMMENDATION: Record<ExceptionKind, (flag: ExceptionFlag) => string> = {
  NOT_COVERED: () => "Connect this mailbox to include it in the team's numbers.",
  STALE_WAITING: (flag) =>
    `Start with the ${flag.observed} thread${plural(flag.observed)} that ${wasWere(flag.observed)} waiting longest.`,
  OVERDUE_WAITING: (flag) =>
    `Clear the ${flag.observed} thread${plural(flag.observed)} already past the response target.`,
  UNANSWERED: (flag) =>
    `Check the ${flag.observed} thread${plural(flag.observed)} that received no reply in this period.`,
  ANSWERED_LATE: (flag) =>
    `${flag.observed} thread${plural(flag.observed)} ${wasWere(flag.observed)} answered, but after the target — worth a look at what delayed ${flag.observed === 1 ? "it" : "them"}.`,
  PENDING_BACKLOG: (flag) =>
    `${flag.observed} threads are open. Worth checking whether the load is shared as intended.`,
};

/**
 * Everything outside target for one person or one group.
 *
 * Kinds coexist on purpose, and that is not double-counting: a person three
 * days into an unanswered thread carries UNANSWERED, OVERDUE_WAITING and
 * STALE_WAITING at once, because one says nobody replied, one says it passed the
 * target, and one says it has fallen off the radar. They are nested populations
 * (stale ⊆ overdue ⊆ waiting) and the UI shows them as such rather than adding
 * them together.
 *
 * NOT_COVERED is the one exclusive kind. Somebody with no numbers has no
 * performance flags, because inferring "answered nothing" from "we cannot see
 * anything" is precisely the failure the coverage concept exists to prevent.
 */
export function exceptionsFor(
  input: { metrics: MemberMetrics | AggregateMetrics | null; coverage: CoverageState },
  policy: SlaPolicy,
): ExceptionFlag[] {
  const klass = policy.classes[0];
  if (!klass) throw new Error("SLA policy has no traffic classes");

  if (input.coverage !== "COVERED" || !input.metrics) {
    return [
      {
        kind: "NOT_COVERED",
        severity: SEVERITY.NOT_COVERED,
        reason: "No numbers for this person — their mailbox is not connected to Mailroid.",
        observed: 0,
        threshold: 0,
        unit: "THREADS",
        trafficClass: klass.id,
      },
    ];
  }

  const metrics = input.metrics;
  const target = klass.target;
  const found: ExceptionFlag[] = [];

  const answeredLate = Math.max(0, metrics.threadsAnswered - metrics.threadsAnsweredWithinTarget);
  if (answeredLate > 0) {
    found.push(
      flag(klass.id, "ANSWERED_LATE", answeredLate, target.firstResponseSeconds, "SECONDS",
        `${answeredLate} of ${metrics.threadsRespondable} threads were first answered after the ${formatTargetHours(target.firstResponseSeconds)} target`),
    );
  }

  const unanswered = Math.max(0, metrics.threadsRespondable - metrics.threadsAnswered);
  if (unanswered > 0) {
    found.push(
      flag(klass.id, "UNANSWERED", unanswered, metrics.threadsRespondable, "THREADS",
        `${unanswered} of ${metrics.threadsRespondable} threads that expect a reply received none`),
    );
  }

  if (metrics.threadsOverdue > 0) {
    found.push(
      flag(klass.id, "OVERDUE_WAITING", metrics.threadsOverdue, target.firstResponseSeconds, "THREADS",
        `${metrics.threadsOverdue} of ${metrics.threadsAwaitingReply} waiting threads have been open longer than the ${formatTargetHours(target.firstResponseSeconds)} target`),
    );
  }

  if (metrics.threadsStale > 0) {
    found.push(
      flag(klass.id, "STALE_WAITING", metrics.threadsStale, target.staleAfterSeconds, "THREADS",
        `${metrics.threadsStale} waiting thread${plural(metrics.threadsStale)} ${hasHave(metrics.threadsStale)} been open longer than ${formatTargetHours(target.staleAfterSeconds)}`),
    );
  }

  if (metrics.threadsAwaitingReply >= PENDING_BACKLOG_THREADS) {
    found.push(
      flag(klass.id, "PENDING_BACKLOG", metrics.threadsAwaitingReply, PENDING_BACKLOG_THREADS, "THREADS",
        `${metrics.threadsAwaitingReply} threads are waiting for a reply. This is a measure of load, not of performance.`),
    );
  }

  return found.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** One line per flag, in the same order. Never more, never fewer. */
export function recommendationsFor(flags: readonly ExceptionFlag[]): Recommendation[] {
  return flags.map((entry) => ({
    forKind: entry.kind,
    text: RECOMMENDATION[entry.kind](entry),
  }));
}

function flag(
  trafficClass: TrafficClassId,
  kind: ExceptionKind,
  observed: number,
  threshold: number,
  unit: ExceptionFlag["unit"],
  reason: string,
): ExceptionFlag {
  return { kind, severity: SEVERITY[kind], reason, observed, threshold, unit, trafficClass };
}

const plural = (n: number) => (n === 1 ? "" : "s");
const wasWere = (n: number) => (n === 1 ? "was" : "were");
const hasHave = (n: number) => (n === 1 ? "has" : "have");
