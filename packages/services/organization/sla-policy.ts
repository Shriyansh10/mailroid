/**
 * Response targets, and the judgements derived from them. No IO, no imports
 * beyond types and the existing category sets.
 *
 * Everything here is a Mailroid product default. It is not a legal or
 * regulatory requirement, not a company policy, and not an agreement any
 * customer has made — until an organization configures its own targets, these
 * numbers are ours, and every string that renders them says so.
 *
 * ── Response coverage is a cohort, which is not what "rate" sounds like ──
 *
 * A thread enters a reporting window by the timestamp of its FIRST respondable
 * inbound. Whether it was answered, and whether within target, is then measured
 * over all time — not only inside the window. A thread that arrived on the last
 * day of the month and was answered two days later counts as answered.
 *
 * That is deliberate: the alternative punishes somebody for where the window's
 * edge happened to fall, and makes the number move every time the page is
 * reloaded. But it means "12 of 15" describes a cohort of threads, not activity
 * during a period, and the UI has to say which.
 */

import { INBOUND_RESPONDABLE } from "./metrics-policy.ts";
import type { MailCategory } from "./types.ts";

/**
 * The three constants below are three different kinds of thing, and conflating
 * them is how a UI surfacing threshold ends up being described to a customer as
 * a service level agreement.
 *
 *   Response target     — SLA-shaped. The one an organization would agree to.
 *   Staleness threshold — a product heuristic for "this fell off the radar".
 *   Backlog threshold   — a surfacing threshold for the UI, nothing more.
 */

/**
 * Response target: how long a first reply may take.
 *
 * Wall clock, NOT working hours — there is no per-member working-hours or
 * timezone data anywhere in the product, so mail arriving on Friday evening is
 * overdue by Saturday morning. UI copy must say "4 hours (clock time)" and must
 * not imply business hours, which would be a claim the data cannot support.
 */
export const FIRST_RESPONSE_TARGET_SECONDS = 4 * 60 * 60;

/** Staleness threshold: how long a still-waiting thread may sit before it has fallen off the radar. */
export const STALE_AFTER_SECONDS = 48 * 60 * 60;

/**
 * Backlog threshold: how many waiting threads before the backlog is worth
 * surfacing. Fires at this many OR MORE.
 *
 * A demo/default surfacing threshold, not an indication of poor performance.
 * Ten is nothing for a support inbox and a lot for a finance lead, and until
 * targets are per-organization this number cannot know the difference — which
 * is why the flag it raises is INFO severity and never ACT.
 */
export const PENDING_BACKLOG_THREADS = 10;

/**
 * Where ON_TARGET becomes SLIPPING becomes OFF_TARGET, as a share of the
 * cohort answered within target. Product defaults, same as everything else
 * here, and stated as constants so the boundaries are visible rather than
 * buried in a comparison chain.
 */
export const ON_TARGET_AT_OR_ABOVE = 0.9;
export const SLIPPING_AT_OR_ABOVE = 0.75;

export type TrafficClassId = "RESPONDABLE";

export interface SlaTarget {
  /** How long a first reply may take before it is late. */
  firstResponseSeconds: number;
  /** How long a still-waiting thread may sit before it is stale. */
  staleAfterSeconds: number;
}

/**
 * A class of mail and what is expected of it.
 *
 * A record rather than a branch in the code, so that adding "customer mail"
 * and "internal mail" later is a data change and not a rewrite of every
 * function that touches a target. Exactly one class exists today, because
 * distinguishing customer from internal needs the sender's domain and the
 * organization services are not permitted to read it.
 */
export interface TrafficClass {
  id: TrafficClassId;
  /** Manager-facing. Rendered as prose; an enum must never reach the screen. */
  label: string;
  categories: readonly MailCategory[];
  target: SlaTarget;
}

export interface SlaPolicy {
  classes: readonly TrafficClass[];
}

export const RESPONDABLE_CLASS: TrafficClass = {
  id: "RESPONDABLE",
  label: "Mail that expects a reply",
  categories: INBOUND_RESPONDABLE,
  target: {
    firstResponseSeconds: FIRST_RESPONSE_TARGET_SECONDS,
    staleAfterSeconds: STALE_AFTER_SECONDS,
  },
};

export const MAILROID_DEFAULT_SLA_POLICY: SlaPolicy = { classes: [RESPONDABLE_CLASS] };

/**
 * Null for an id this policy does not define — never a fallback to the default
 * class. Silently measuring the wrong mail with a right-looking number is the
 * failure mode this whole module is arranged to avoid.
 */
export function trafficClassById(policy: SlaPolicy, id: string): TrafficClass | null {
  return policy.classes.find((klass) => klass.id === id) ?? null;
}

export function defaultTrafficClass(policy: SlaPolicy): TrafficClass {
  const first = policy.classes[0];
  if (!first) throw new Error("SLA policy has no traffic classes");
  return first;
}

/**
 * Validate before any metric consumes the policy.
 *
 * Today the targets are constants and cannot be wrong. The moment they are read
 * from a table they can be, and a malformed target reaching the SQL layer
 * produces a dashboard that is confidently, unfalsifiably wrong. Throwing here
 * is free now and is the only thing standing between a future per-organization
 * editor and a nonsense policy.
 */
export function assertValidPolicy(policy: SlaPolicy): void {
  if (policy.classes.length === 0) {
    throw new Error("SLA policy must define at least one traffic class");
  }

  const seen = new Set<string>();
  for (const klass of policy.classes) {
    if (seen.has(klass.id)) {
      throw new Error(`SLA policy defines traffic class ${klass.id} twice`);
    }
    seen.add(klass.id);

    if (klass.categories.length === 0) {
      throw new Error(`Traffic class ${klass.id} matches no mail categories`);
    }

    assertValidSeconds(klass.id, "firstResponseSeconds", klass.target.firstResponseSeconds);
    assertValidSeconds(klass.id, "staleAfterSeconds", klass.target.staleAfterSeconds);

    // Stale must stay a superset of overdue, or the two counts contradict each
    // other on one screen: more stale threads than overdue ones is unreadable.
    if (klass.target.staleAfterSeconds < klass.target.firstResponseSeconds) {
      throw new Error(
        `Traffic class ${klass.id} goes stale before it is overdue ` +
          `(${klass.target.staleAfterSeconds}s < ${klass.target.firstResponseSeconds}s)`,
      );
    }
  }
}

function assertValidSeconds(classId: string, field: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Traffic class ${classId} has an invalid ${field}: ${String(value)}`);
  }
}

/** Inclusive: a reply landing exactly on the target is within it. */
export function isWithinTarget(firstResponseSeconds: number, target: SlaTarget): boolean {
  return firstResponseSeconds <= target.firstResponseSeconds;
}

export function isOverdue(waitingSeconds: number, target: SlaTarget): boolean {
  return waitingSeconds > target.firstResponseSeconds;
}

export function isStale(waitingSeconds: number, target: SlaTarget): boolean {
  return waitingSeconds > target.staleAfterSeconds;
}

/**
 * How a person or a group is doing against the response target.
 *
 * Four states, and this set is closed. An ordinal vocabulary — excellent, good,
 * average, poor — is a rating wearing adjectives, and reintroduces by another
 * route the composite score this feature deliberately does not have.
 *
 * NOT_COVERED is NOT one of these. It is a coverage state, it lives in
 * metrics-policy.ts, and it is combined with this one at the render boundary.
 * Putting it here would invite an implementation of coverage inside a module
 * built to know nothing about accounts.
 */
export type AdherenceStatus = "NO_DATA" | "ON_TARGET" | "SLIPPING" | "OFF_TARGET";

export interface Adherence {
  status: AdherenceStatus;
  /** Always populated, always carries both numbers. A status nobody can question is a status nobody trusts. */
  reason: string;
}

export function adherenceStatus(input: {
  threadsRespondable: number;
  threadsAnsweredWithinTarget: number;
  target: SlaTarget;
}): Adherence {
  const { threadsRespondable, threadsAnsweredWithinTarget, target } = input;
  const targetLabel = formatTargetHours(target.firstResponseSeconds);

  // Zero respondable threads is NO_DATA, never ON_TARGET. Somebody who received
  // no mail that expects a reply is not perfectly adherent — they are
  // unmeasured, and saying otherwise puts a green badge on an empty mailbox.
  if (threadsRespondable === 0) {
    return {
      status: "NO_DATA",
      reason: "No mail that expects a reply arrived in this period",
    };
  }

  const share = threadsAnsweredWithinTarget / threadsRespondable;
  const reason =
    `${threadsAnsweredWithinTarget} of ${threadsRespondable} threads were ` +
    `first answered within ${targetLabel}`;

  if (share >= ON_TARGET_AT_OR_ABOVE) return { status: "ON_TARGET", reason };
  if (share >= SLIPPING_AT_OR_ABOVE) return { status: "SLIPPING", reason };
  return { status: "OFF_TARGET", reason };
}

/** "4h", "30m", "1h 30m" — for reason strings, which are read by people. */
export function formatTargetHours(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
