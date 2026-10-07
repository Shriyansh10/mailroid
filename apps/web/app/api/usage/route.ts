import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db, eq, and } from "@repo/database";
import { userUsage } from "@repo/database/schema";
import { resolveEffectiveTimeZone } from "@web/lib/timezone";
import { resolveEntitlement } from "@repo/services/entitlements";
import { limitFor, PLAN_LIMITS } from "@repo/services/usage-limits";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const entitlement = await resolveEntitlement(userId);

    if (entitlement.isDeveloper) {
      return NextResponse.json({
        actionCount: 0,
        limit: 9999,
        remaining: 9999,
        unlocked: true,
        feedbackUnlocks: 0,
        unlockedBonus: 0,
        plan: entitlement.plan,
        isDeveloper: true,
        expiresAt: null,
        expiringSoon: false,
      });
    }

    const safeTimeZone = (await resolveEffectiveTimeZone(userId, request)) ?? "UTC";
    const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: safeTimeZone });

    const [usage] = await db
      .select()
      .from(userUsage)
      .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
      .limit(1);

    const actionCount = usage ? usage.actionCount : 0;
    const unlocked = usage ? usage.unlocked : false;
    const limit = limitFor(entitlement.plan, unlocked);
    const remaining = Math.max(0, limit - actionCount);

    return NextResponse.json({
      actionCount,
      limit,
      remaining,
      unlocked,
      feedbackUnlocks: usage ? (usage.feedbackUnlocks || 0) : 0,
      // Sent so the widget can name the offer without hardcoding a number that
      // drifts the moment PLAN_LIMITS changes.
      unlockedBonus: PLAN_LIMITS[entitlement.plan].unlockedBonus,
      plan: entitlement.plan,
      isDeveloper: false,
      expiresAt: entitlement.expiresAt?.toISOString() ?? null,
      expiringSoon: entitlement.expiringSoon,
    });
  } catch (error) {
    console.error("[api:usage] Error fetching usage:", error);
    return NextResponse.json({ error: "Failed to fetch usage metrics" }, { status: 500 });
  }
}
