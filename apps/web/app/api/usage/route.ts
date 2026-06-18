import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db, eq, and } from "@repo/database";
import { userUsage } from "@repo/database/schema";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    const userEmail = session.user.email;

    // Check whitelist
    const whitelistStr = process.env.WHITELISTED_EMAILS || "";
    const whitelistedEmails = whitelistStr.split(",").map((e) => e.trim().toLowerCase());
    const isWhitelisted = whitelistedEmails.includes(userEmail.toLowerCase());

    if (isWhitelisted) {
      return NextResponse.json({
        actionCount: 0,
        limit: 9999,
        remaining: 9999,
        unlocked: true,
        feedbackUnlocks: 0,
      });
    }

    const userTimeZone = request.headers.get("x-user-timezone") || "UTC";
    const tzRegex = /^[a-zA-Z0-9_\/+-]+$/;
    const safeTimeZone = tzRegex.test(userTimeZone) ? userTimeZone : "UTC";
    const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: safeTimeZone });

    const [usage] = await db
      .select()
      .from(userUsage)
      .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
      .limit(1);

    const actionCount = usage ? usage.actionCount : 0;
    const unlocked = usage ? usage.unlocked : false;
    const limit = unlocked ? 20 : 10;
    const remaining = Math.max(0, limit - actionCount);

    return NextResponse.json({
      actionCount,
      limit,
      remaining,
      unlocked,
      feedbackUnlocks: usage ? (usage.feedbackUnlocks || 0) : 0,
    });
  } catch (error) {
    console.error("[api:usage] Error fetching usage:", error);
    return NextResponse.json({ error: "Failed to fetch usage metrics" }, { status: 500 });
  }
}
