/**
 * Metric definitions, with no IO.
 *
 * The category sets live here because getting them wrong is silent: a report
 * that counts spam as received mail still renders, still looks plausible, and
 * is wrong in a way nobody notices until a customer asks why they have four
 * hundred unanswered threads.
 */

import type { MailCategory } from "./types.ts";

/**
 * Everything that arrived. Excludes SENT (outbound), DRAFT (never sent),
 * SPAM and TRASH (not correspondence).
 *
 * Written as an explicit set rather than `category <> 'SENT'`, which was the
 * first instinct and is wrong — the enum has ten values, so "not SENT" quietly
 * counts drafts, spam and trash as mail this person received.
 */
export const INBOUND_VOLUME: readonly MailCategory[] = [
  "PRIMARY",
  "PROMOTIONS",
  "SOCIAL",
  "UPDATES",
  "FORUMS",
  "OTHER",
];

/**
 * Mail a human might reasonably be expected to answer. Used by response time
 * and threads-awaiting-reply.
 *
 * Narrower than INBOUND_VOLUME on purpose: nobody replies to a newsletter, and
 * counting PROMOTIONS and SOCIAL as awaiting a reply would make that metric
 * enormous, permanently red, and useless on day one.
 *
 * This is the first thing to tune if the numbers look wrong for a given
 * customer — it is a product judgement, not a fact about mail.
 */
export const INBOUND_RESPONDABLE: readonly MailCategory[] = ["PRIMARY", "OTHER"];

export const SENT_CATEGORY: MailCategory = "SENT";

/** Why a member has no numbers. Rendered instead of metrics, never hidden. */
export type CoverageState =
  | "COVERED"
  | "NO_ACCOUNT"
  | "NO_GMAIL"
  | "GMAIL_ERROR"
  | "MAILBOX_MISMATCH";

export interface MemberCoverage {
  email: string;
  state: CoverageState;
  /** NULL unless the member has a Mailroid account. */
  userId: string | null;
  /**
   * The account's display name, for labelling a row the viewer may already
   * see. NULL without an account — the UI falls back to the email.
   */
  name: string | null;
}

export function isCovered(coverage: MemberCoverage): boolean {
  return coverage.state === "COVERED";
}

/**
 * Median of a sample, in whatever unit it was given.
 *
 * Median rather than mean because one forgotten thread — a week-old message
 * answered eventually, or never — drags a mean far enough to misrepresent
 * everything else the person did. With small samples that single outlier is the
 * difference between "responsive" and "unresponsive".
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * Is this thread waiting on the employee?
 *
 * Stated as a comparison of two maxima, not "an inbound with no later reply".
 * The naive form misreads the most ordinary shape there is —
 * inbound → replied → they wrote back — as answered, when it is in fact waiting
 * again.
 */
export function isAwaitingReply(input: {
  lastRespondableInboundAt: Date | null;
  lastSentAt: Date | null;
}): boolean {
  if (!input.lastRespondableInboundAt) return false;
  if (!input.lastSentAt) return true;
  return input.lastRespondableInboundAt > input.lastSentAt;
}
