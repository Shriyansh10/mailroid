import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db, eq, and, sql } from "@repo/database";
import { feedbacks, userUsage } from "@repo/database/schema";
import { evaluateFeedback } from "@repo/ai";

export const runtime = "nodejs";

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]|_/g, "") // remove punctuation and underscores
    .replace(/\s+/g, " "); // collapse whitespace
}

function getJaccardSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.split(" ").filter((w) => w.length > 0));
  const words2 = new Set(text2.split(" ").filter((w) => w.length > 0));
  if (words1.size === 0 && words2.size === 0) return 1;

  const intersection = new Set([...words1].filter((w) => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * POST /api/feedback
 */
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let body: { feedbackText?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const rawFeedback = body.feedbackText || "";
    const trimmedFeedback = rawFeedback.trim();

    // Check basic length requirements (30 to 2000 characters)
    if (trimmedFeedback.length < 30 || trimmedFeedback.length > 2000) {
      return NextResponse.json(
        { error: "Feedback must be between 30 and 2000 characters." },
        { status: 400 }
      );
    }

    // Normalize feedback for duplicate checks
    const normalized = normalizeText(trimmedFeedback);

    // Resolve date and timezone
    const userTimeZone = request.headers.get("x-user-timezone") || "UTC";
    const tzRegex = /^[a-zA-Z0-9_\/+-]+$/;
    const safeTimeZone = tzRegex.test(userTimeZone) ? userTimeZone : "UTC";
    const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: safeTimeZone });

    // Check unlock state database-wide to block multiple unlocks today
    const [usage] = await db
      .select()
      .from(userUsage)
      .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
      .limit(1);

    if (usage && usage.unlocked) {
      return NextResponse.json(
        { error: "You have already unlocked additional actions for today." },
        { status: 400 }
      );
    }

    // Query feedbacks submitted today to check for approved status and similarity duplicates
    const submissions = await db
      .select()
      .from(feedbacks)
      .where(
        and(
          eq(feedbacks.userId, userId),
          sql`TO_CHAR(${feedbacks.createdAt} AT TIME ZONE ${safeTimeZone}, 'YYYY-MM-DD') = ${dateStr}`
        )
      );

    const approvedToday = submissions.some((s) => s.approved);
    if (approvedToday) {
      return NextResponse.json(
        { error: "You have already unlocked additional actions for today." },
        { status: 400 }
      );
    }

    // Similarity check: Reject if Jaccard similarity > 0.90
    for (const sub of submissions) {
      const similarity = getJaccardSimilarity(normalized, sub.normalizedText);
      if (similarity > 0.90) {
        return NextResponse.json(
          { error: "Duplicate feedback detected. Please write original feedback." },
          { status: 400 }
        );
      }
    }

    // Evaluate feedback via the AI model using original text (or normalized if requested,
    // let's use the normalized text as specified in the plan)
    const evalResult = await evaluateFeedback(normalized);

    const isApproved = evalResult.approved && evalResult.score >= 0.60;
    const isBorderline = !isApproved && evalResult.score >= 0.50 && evalResult.score < 0.60;

    // Transactionally update database rows
    await db.transaction(async (tx) => {
      // 1. Double check again under locking tx to prevent concurrent bypass
      const [lockUsage] = await tx
        .select()
        .from(userUsage)
        .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
        .for("update")
        .limit(1);

      if (lockUsage && lockUsage.unlocked) {
        throw new Error("Lock: You have already unlocked additional actions for today.");
      }

      // 2. Persist feedback submission
      await tx.insert(feedbacks).values({
        userId,
        feedbackText: trimmedFeedback,
        normalizedText: normalized,
        score: evalResult.score,
        category: evalResult.category,
        approved: isApproved,
        requiresReview: isBorderline,
        reason: evalResult.reason,
      });

      // 3. Update usage counts
      if (isApproved) {
        if (lockUsage) {
          await tx
            .update(userUsage)
            .set({
              unlocked: true,
              feedbackUnlocks: (lockUsage.feedbackUnlocks || 0) + 1,
            })
            .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)));
        } else {
          await tx.insert(userUsage).values({
            userId,
            date: dateStr,
            actionCount: 0,
            unlocked: true,
            feedbackUnlocks: 1,
            feedbackRejected: 0,
          });
        }
      } else {
        if (lockUsage) {
          await tx
            .update(userUsage)
            .set({
              feedbackRejected: (lockUsage.feedbackRejected || 0) + 1,
            })
            .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)));
        } else {
          await tx.insert(userUsage).values({
            userId,
            date: dateStr,
            actionCount: 0,
            unlocked: false,
            feedbackUnlocks: 0,
            feedbackRejected: 1,
          });
        }
      }
    });

    return NextResponse.json({
      approved: isApproved,
      score: evalResult.score,
      category: evalResult.category,
      reason: evalResult.reason,
    });
  } catch (error) {
    console.error("[api:feedback] Error processing feedback:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    if (message.includes("Lock:")) {
      return NextResponse.json({ error: message.replace("Lock: ", "") }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to process feedback submission" }, { status: 500 });
  }
}
