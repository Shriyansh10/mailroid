import { db, eq, and } from "@repo/database";
import { userUsage } from "@repo/database/models/user-usage";

/**
 * Generic daily-action-limit ("credit") accounting, shared by every AI-costing
 * user action: chat turns, tool approvals, email generation, summarization,
 * and bulk priority classification. Lives here (not app-specific) because
 * packages/services/gmail/classification.ts needs it and cannot depend on
 * apps/web — apps/web/lib/limits.ts re-exports these verbatim so its existing
 * callers need no changes.
 */

export interface UsageCheckResult {
  allowed: boolean;
  unlocked: boolean;
  actionCount: number;
  limit: number;
  message?: string;
}

function whitelisted(userEmail?: string): boolean {
  if (!userEmail) return false;
  const whitelistStr = process.env.WHITELISTED_EMAILS || "";
  const whitelistedEmails = whitelistStr.split(",").map((e) => e.trim().toLowerCase());
  return whitelistedEmails.includes(userEmail.toLowerCase());
}

/**
 * Check if the user is within their daily action limits.
 * Whitelisted email addresses bypass limits completely.
 */
export async function checkDailyLimit(
  userId: string,
  userEmail?: string,
  userTimeZone = "UTC",
): Promise<UsageCheckResult> {
  if (whitelisted(userEmail)) {
    return { allowed: true, unlocked: true, actionCount: 0, limit: 9999 };
  }

  const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: userTimeZone });

  const [usage] = await db
    .select()
    .from(userUsage)
    .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
    .limit(1);

  const actionCount = usage ? usage.actionCount : 0;
  const unlocked = usage ? usage.unlocked : false;
  const limit = unlocked ? 20 : 10;

  if (actionCount >= limit) {
    const message = unlocked
      ? "🎯 You've reached your maximum limit of 20 assistant actions today. Please check back tomorrow to continue helping us shape Mailroid!"
      : "🎯 You're helping shape Mailroid. You've used your first 10 assistant actions today. Share a bug report, feature request, or product feedback to unlock 10 more actions.";
    return { allowed: false, unlocked, actionCount, limit, message };
  }

  return { allowed: true, unlocked, actionCount, limit };
}

/**
 * Atomically increment daily action usage count inside a row-locking database transaction.
 * Bypasses increment if the user email is whitelisted.
 * Returns true if increment succeeded, false if limit was exceeded under lock.
 */
export async function incrementDailyLimit(
  userId: string,
  userEmail?: string,
  userTimeZone = "UTC",
): Promise<boolean> {
  return incrementDailyLimitBy(userId, userEmail, userTimeZone, 1);
}

/**
 * Same row-locked read-modify-write as incrementDailyLimit, but adds `amount`
 * in one step and rejects (returns false, no write) if actionCount + amount
 * would exceed the limit — used by bulk classification to charge N credits
 * atomically for a single job rather than N separate increments.
 */
export async function incrementDailyLimitBy(
  userId: string,
  userEmail: string | undefined,
  userTimeZone: string | undefined,
  amount: number,
): Promise<boolean> {
  if (whitelisted(userEmail)) {
    return true; // Bypass increment
  }

  const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: userTimeZone ?? "UTC" });

  return await db.transaction(async (tx) => {
    const [usage] = await tx
      .select()
      .from(userUsage)
      .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
      .for("update")
      .limit(1);

    const actionCount = usage ? usage.actionCount : 0;
    const unlocked = usage ? usage.unlocked : false;
    const limit = unlocked ? 20 : 10;

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
  userEmail: string | undefined,
  userTimeZone: string | undefined,
  amount: number,
): Promise<void> {
  if (whitelisted(userEmail) || amount <= 0) return;

  const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: userTimeZone ?? "UTC" });

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
