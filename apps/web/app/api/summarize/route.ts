import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { getOrCreateSummary } from "@web/lib/summarize/get-or-create-summary";
import { resolveEffectiveTimeZone } from "@web/lib/timezone";

export const runtime = "nodejs";

/**
 * POST /api/summarize — on-demand one-line summary for a single thread.
 *
 * Thin wrapper over the shared getOrCreateSummary pipeline (also used by
 * Dobbie's summarizeEmail tool executor) — costs one daily action, charged
 * only after a summary is actually produced, never on a cache hit.
 *
 * All guardrails — PII masking, secret redaction, prompt-injection
 * stripping, link neutralization — live in summarizeEmail; see
 * packages/ai/src/prompts/summarize.ts.
 */
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let body: { entityId?: string; threadId?: string; messageCount?: number; force?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const entityId = body.entityId?.trim();
    if (!entityId) {
      return NextResponse.json({ error: "entityId is required" }, { status: 400 });
    }

    const userTimeZone = await resolveEffectiveTimeZone(userId, request);

    const outcome = await getOrCreateSummary({
      userId,
      userEmail: session.user.email,
      entityId,
      threadId: body.threadId?.trim() || undefined,
      // Untrusted lower bound only — normalizeMessageCountHint clamps it and
      // it can never do more than force the slower Gmail path.
      messageCountHint: body.messageCount,
      force: body.force,
      userTimeZone,
      charge: "on-generate",
    });

    if (!outcome.ok) {
      const statusByReason: Record<string, number> = {
        not_found: 404,
        no_content: 422,
        limit_reached: 429,
        generation_failed: 500,
        ambiguous: 409,
        blocked: 403,
      };
      return NextResponse.json({ error: outcome.message }, { status: statusByReason[outcome.reason] ?? 500 });
    }

    return NextResponse.json({
      summary: outcome.summary,
      digest: outcome.digest,
      fullText: outcome.fullText,
      data: outcome.data,
      meta: outcome.meta,
      flags: outcome.flags,
      cached: outcome.source === "cache",
    });
  } catch (error) {
    console.error("[api:summarize] Error generating summary:", error);
    return NextResponse.json({ error: "Failed to generate summary" }, { status: 500 });
  }
}
