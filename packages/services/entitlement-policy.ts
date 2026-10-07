/**
 * The entitlement rules, with no IO.
 *
 * Split from entitlements.ts for the same reason mailbox-policy.ts is split
 * from the code that uses it: these are the decisions, and decisions should be
 * testable without a database. entitlements.ts does the reading and writing and
 * defers every judgement to this file.
 */

export type Plan = "FREE" | "PRO" | "ULTIMATE";

export interface PlanLimits {
  /** Assistant actions per day before the cap bites. */
  dailyActions: number;
  /**
   * Extra actions granted by the accepted-feedback unlock. Only FREE offers
   * this — it exists to buy product feedback from users who are not paying,
   * which is not a trade a paying user should have to make.
   */
  unlockedBonus: number;
}

/**
 * Deliberately code, not a table. Three plans do not justify making limits
 * editable data — a map is version-controlled, reviewable in a diff, and cannot
 * be typo'd into production by a stray UPDATE.
 *
 * The exact PRO/ULTIMATE numbers are a pricing decision that is still open.
 * They are safe to change here alone; nothing else reads a literal.
 *
 * There is no DEVELOPER entry, and there must never be one: developer authority
 * is a platform role, not something anyone buys.
 */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  FREE: { dailyActions: 50, unlockedBonus: 10 },
  PRO: { dailyActions: 100, unlockedBonus: 0 },
  ULTIMATE: { dailyActions: 1000, unlockedBonus: 0 },
};

/** How long before expiry the UI should start warning. */
export const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

/** The minimum a subscription row must carry for an access decision. */
export interface SubscriptionState {
  status: "ACTIVE" | "CANCELLED";
  currentPeriodEnd: Date;
}

/**
 * The single definition of "paid up right now", used for users and
 * organizations alike.
 *
 * Expiry is derived here rather than stored, so no scheduled job can leave
 * anyone in a wrongly-paid state by failing to run. CANCELLED is immediate
 * revocation, not run-to-period-end: a manual grant that gets revoked should
 * stop counting the moment it is revoked.
 */
export function isSubscriptionActive(
  row: SubscriptionState | undefined | null,
  now = new Date(),
): boolean {
  if (!row) return false;
  if (row.status !== "ACTIVE") return false;
  return now < row.currentPeriodEnd;
}

/** True on the final day of a paid period. Drives the renewal warning. */
export function isExpiringSoon(expiresAt: Date | null, now = new Date()): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - now.getTime() <= EXPIRY_WARNING_MS;
}

/** The cap in force for a plan, given whether feedback has unlocked the bonus. */
export function limitFor(plan: Plan, unlocked: boolean): number {
  const limits = PLAN_LIMITS[plan];
  return limits.dailyActions + (unlocked ? limits.unlockedBonus : 0);
}
