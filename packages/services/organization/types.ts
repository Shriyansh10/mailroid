/**
 * Shapes shared between the organization policy modules (which must not import
 * the database) and the services that do.
 */

export type MailCategory =
  | "PRIMARY"
  | "PROMOTIONS"
  | "SOCIAL"
  | "UPDATES"
  | "FORUMS"
  | "SENT"
  | "SPAM"
  | "TRASH"
  | "DRAFT"
  | "OTHER";

export interface MetricWindow {
  from: Date;
  to: Date;
}

/**
 * One member's numbers. Every field is a count or a duration — there is
 * deliberately no composite score, rating or rank here, and none may be added:
 * V1 reports what happened and lets a manager interpret it. A single number
 * that claims to summarise a person is a much larger product decision than
 * this feature, and was explicitly deferred.
 */
export interface MemberMetrics {
  email: string;
  received: number;
  sent: number;
  /** NULL when nothing in the window was answered — not zero, which would lie. */
  medianResponseSeconds: number | null;
  /**
   * Threads whose first respondable inbound fell inside the window. The
   * denominator for response coverage, and a cohort rather than a period —
   * see the header of `sla-policy.ts`.
   */
  threadsRespondable: number;
  threadsAnswered: number;
  /** Of `threadsRespondable`, how many were first answered within the response target. */
  threadsAnsweredWithinTarget: number;
  threadsAwaitingReply: number;
  /** Of `threadsAwaitingReply`, how many have waited past the response target. */
  threadsOverdue: number;
  /** Of `threadsOverdue`, how many have waited past the staleness threshold. */
  threadsStale: number;
  /** NULL when nothing is waiting — not zero, which reads as "waiting no time at all". */
  oldestWaitingSeconds: number | null;
}

/**
 * A group total across one or more mailboxes — same fields as
 * `MemberMetrics`, minus `email`, because it describes no single person.
 * Same rule applies: a count or a duration, never a score, rating or rank.
 */
export type AggregateMetrics = Omit<MemberMetrics, "email">;
