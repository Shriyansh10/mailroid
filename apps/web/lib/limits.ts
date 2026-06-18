import { db, eq, and, sql } from "@repo/database";
import { userUsage } from "@repo/database/schema";

export interface UsageCheckResult {
  allowed: boolean;
  unlocked: boolean;
  actionCount: number;
  limit: number;
  message?: string;
}

/**
 * Check if the user is within their daily action limits.
 * Whitelisted email addresses bypass limits completely.
 */
export async function checkDailyLimit(
  userId: string,
  userEmail?: string,
  userTimeZone = "UTC"
): Promise<UsageCheckResult> {
  // Whitelist check
  if (userEmail) {
    const whitelistStr = process.env.WHITELISTED_EMAILS || "";
    const whitelistedEmails = whitelistStr.split(",").map((e) => e.trim().toLowerCase());
    if (whitelistedEmails.includes(userEmail.toLowerCase())) {
      return { allowed: true, unlocked: true, actionCount: 0, limit: 9999 };
    }
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
  userTimeZone = "UTC"
): Promise<boolean> {
  // Whitelist check
  if (userEmail) {
    const whitelistStr = process.env.WHITELISTED_EMAILS || "";
    const whitelistedEmails = whitelistStr.split(",").map((e) => e.trim().toLowerCase());
    if (whitelistedEmails.includes(userEmail.toLowerCase())) {
      return true; // Bypass increment
    }
  }

  const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: userTimeZone });

  return await db.transaction(async (tx) => {
    // Select with row-level lock (FOR UPDATE)
    const [usage] = await tx
      .select()
      .from(userUsage)
      .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
      .for("update")
      .limit(1);

    const actionCount = usage ? usage.actionCount : 0;
    const unlocked = usage ? usage.unlocked : false;
    const limit = unlocked ? 20 : 10;

    if (actionCount >= limit) {
      return false; // Limit exceeded concurrently
    }

    if (!usage) {
      await tx.insert(userUsage).values({
        userId,
        date: dateStr,
        actionCount: 1,
        unlocked: false,
      });
    } else {
      await tx
        .update(userUsage)
        .set({ actionCount: actionCount + 1 })
        .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)));
    }
    return true;
  });
}
