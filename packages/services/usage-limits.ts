import { db, eq, and } from "@repo/database";
import { userUsage } from "@repo/database/models/user-usage";

import { PLAN_LIMITS, limitFor, type Plan } from "./entitlement-policy.ts";
import { resolveEntitlement } from "./entitlements.ts";

/**
 * Generic daily-action-limit ("credit") accounting, shared by every AI-costing
 * user action: chat turns, tool approvals, email generation, summarization,
 * and bulk priority classification. Lives here (not app-specific) because
 * packages/services/gmail/classification.ts needs it and cannot depend on
 * apps/web — apps/web/lib/limits.ts re-exports these verbatim so its existing
 * callers need no changes.
 *
 * The cap comes from the user's plan (@repo/services/entitlements). It used to
 * come from a hardcoded 10/20 with a WHITELISTED_EMAILS env var bypassing it;
 * both are gone. `userEmail` is no longer a parameter anywhere here — identity
 * is the userId, and entitlement is a database read, not a string match against
 * a comma-separated environment variable.
 */

export interface UsageCheckResult {
  allowed: boolean;
  unlocked: boolean;
  actionCount: number;
  limit: number;
  message?: string;
  /**
   * Carried here because every caller that checks the limit before running a
   * tool also needs it for the rate limiter, and this call has already paid for
   * the entitlement read. Returning it avoids a second round trip on a hot path.
   */
  isDeveloper: boolean;
}

/** Sentinel reported for accounts that are not metered at all. */
const UNMETERED = 9999;

export { limitFor };

function todayIn(userTimeZone: string | undefined): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: userTimeZone ?? "UTC" });
}

function limitMessage(plan: Plan, unlocked: boolean, limit: number): string {
  if (plan !== "FREE") {
    return `You've used all ${limit} assistant actions for today on your ${plan} plan. They reset tomorrow.`;
  }
  return unlocked
    ? `🎯 You've reached your maximum limit of ${limit} assistant actions today. Please check back tomorrow to continue helping us shape Mailroid!`
    : `🎯 You're helping shape Mailroid. You've used your first ${limit} assistant actions today. Share a bug report, feature request, or product feedback to unlock ${PLAN_LIMITS.FREE.unlockedBonus} more actions.`;
}

/**
 * Check whether the user is within their daily action limit.
 * A DEVELOPER is not metered — that authority comes from platform_role, never
 * from a plan, so it survives a plan lapsing.
 */
export async function checkDailyLimit(
  userId: string,
  userTimeZone = "UTC",
): Promise<UsageCheckResult> {
  const entitlement = await resolveEntitlement(userId);
  if (entitlement.isDeveloper) {
    return { allowed: true, unlocked: true, actionCount: 0, limit: UNMETERED, isDeveloper: true };
  }

  const dateStr = todayIn(userTimeZone);

  const [usage] = await db
    .select()
    .from(userUsage)
    .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
    .limit(1);

  const actionCount = usage ? usage.actionCount : 0;
  const unlocked = usage ? usage.unlocked : false;
  const limit = limitFor(entitlement.plan, unlocked);

  if (actionCount >= limit) {
    return {
      allowed: false,
      unlocked,
      actionCount,
      limit,
      message: limitMessage(entitlement.plan, unlocked, limit),
      isDeveloper: false,
    };
  }

  return { allowed: true, unlocked, actionCount, limit, isDeveloper: false };
}

/**
 * Atomically increment daily action usage count inside a row-locking database transaction.
 * Returns true if increment succeeded, false if limit was exceeded under lock.
 */
export async function incrementDailyLimit(
  userId: string,
  userTimeZone = "UTC",
): Promise<boolean> {
  return incrementDailyLimitBy(userId, userTimeZone, 1);
}

/**
 * Same row-locked read-modify-write as incrementDailyLimit, but adds `amount`
 * in one step and rejects (returns false, no write) if actionCount + amount
 * would exceed the limit — used by bulk classification to charge N credits
 * atomically for a single job rather than N separate increments.
 */
export async function incrementDailyLimitBy(
  userId: string,
  userTimeZone: string | undefined,
  amount: number,
): Promise<boolean> {
  const entitlement = await resolveEntitlement(userId);
  if (entitlement.isDeveloper) {
    return true; // Not metered.
  }

  const dateStr = todayIn(userTimeZone);

  return await db.transaction(async (tx) => {
    const [usage] = await tx
      .select()
      .from(userUsage)
      .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
      .for("update")
      .limit(1);

    const actionCount = usage ? usage.actionCount : 0;
    const unlocked = usage ? usage.unlocked : false;
    const limit = limitFor(entitlement.plan, unlocked);

    if (actionCount + amount > limit) {
      return false; // Would exceed the limit — reject the whole charge, not a partial one.
    }

    if (!usage) {
      await tx.insert(userUsage).values({
        userId,
        date: dateStr,
        actionCount: amount,
        unlocked: false,
      });
    } else {
      await tx
        .update(userUsage)
        .set({ actionCount: actionCount + amount })
        .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)));
    }
    return true;
  });
}

/**
 * Undoes a charge made by incrementDailyLimitBy that turned out to be for
 * nothing — e.g. bulk classification charges credits, then discovers the job
 * couldn't actually be created (a concurrent request already has one
 * running) and must give the credits back rather than bill for a no-op.
 * Never fails, clamped at 0 (can't refund below zero even under a race with
 * another concurrent charge/refund) — this is a correction, not a user-facing
 * action with its own limit check.
 */
export async function refundDailyLimit(
  userId: string,
  userTimeZone: string | undefined,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;

  const entitlement = await resolveEntitlement(userId);
  if (entitlement.isDeveloper) return; // Was never charged.

  const dateStr = todayIn(userTimeZone);

  await db.transaction(async (tx) => {
    const [usage] = await tx
      .select()
      .from(userUsage)
      .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
      .for("update")
      .limit(1);
    if (!usage) return; // Nothing to refund — the charge somehow never landed.

    await tx
      .update(userUsage)
      .set({ actionCount: Math.max(0, usage.actionCount - amount) })
      .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)));
  });
}
