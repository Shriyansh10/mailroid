import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db, eq, and, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { emails } from "@repo/database/models/emails";
import { summarizeEmail } from "@repo/ai";
import { checkDailyLimit, incrementDailyLimit } from "@web/lib/limits";

export const runtime = "nodejs";

/**
 * POST /api/summarize — on-demand one-line summary for a single thread.
 *
 * Costs one daily action, charged only after a summary is actually produced
 * (mirrors the chat route's check-then-charge ordering, so a provider
 * failure never bills the user). Results are cached on message_metadata, so
 * re-opening a thread is free and the charge happens at most once per email.
 *
 * All guardrails — PII masking, secret redaction, prompt-injection
 * stripping — live in summarizeEmail; see packages/ai/src/prompts/summarize.ts.
 */
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let body: { entityId?: string; force?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const entityId = body.entityId?.trim();
    if (!entityId) {
      return NextResponse.json({ error: "entityId is required" }, { status: 400 });
    }

    // Ownership is enforced by the user_id predicate, not just the id — an
    // entityId from another mailbox must not be summarizable.
    const [meta] = await db
      .select({
        entityId: messageMetadata.entityId,
        threadId: messageMetadata.threadId,
        sender: messageMetadata.sender,
        subject: messageMetadata.subject,
        snippet: messageMetadata.snippet,
        summary: messageMetadata.summary,
        summaryDigest: messageMetadata.summaryDigest,
        summaryFullText: messageMetadata.summaryFullText,
        summaryFlags: messageMetadata.summaryFlags,
        summaryMeta: messageMetadata.summaryMeta,
      })
      .from(messageMetadata)
      .where(
        and(eq(messageMetadata.entityId, entityId), eq(messageMetadata.userId, userId)),
      )
      .limit(1);

    if (!meta) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    // Cache hit — free, and returned before any limit check so a user who is
    // out of actions can still read summaries they already paid for.
    // `force` regenerates instead, which costs another action: the summary
    // prompt evolves, and a stored summary from an older prompt is otherwise
    // unreachable forever.
    if (meta.summary && !body.force) {
      return NextResponse.json({
        summary: meta.summary,
        digest: meta.summaryDigest ?? null,
        fullText: meta.summaryFullText ?? null,
        meta: meta.summaryMeta ?? null,
        flags: meta.summaryFlags ?? null,
        cached: true,
      });
    }

    const userTimeZone = request.headers.get("x-user-timezone") || undefined;

    const limitCheck = await checkDailyLimit(userId, session.user.email, userTimeZone);
    if (!limitCheck.allowed) {
      return NextResponse.json({ error: limitCheck.message }, { status: 429 });
    }

    // Prefer the stored full body; fall back to the snippet when the email
    // row was never fetched (metadata-only sync).
    const [emailRow] = await db
      .select({ bodyText: emails.bodyText })
      .from(emails)
      .where(and(eq(emails.gmailMessageId, entityId), eq(emails.userId, userId)))
      .limit(1);

    const sourceText = emailRow?.bodyText || meta.snippet || "";
    if (!sourceText.trim()) {
      return NextResponse.json(
        { error: "This email has no readable content to summarize." },
        { status: 422 },
      );
    }

    const result = await summarizeEmail({
      sender: meta.sender || "Unknown Sender",
      subject: meta.subject || "No Subject",
      body: sourceText,
    });

    const flags = {
      injectionBlocked: result.injectionBlocked,
      maskedCategories: result.maskedCategories as string[],
      secretsRedacted: result.secretsRedacted,
    };

    await db
      .update(messageMetadata)
      .set({
        summary: result.summary,
        summaryDigest: result.digest,
        summaryFullText: result.fullText,
        summaryFlags: flags,
        summaryMeta: result.analysis,
        summaryGeneratedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(messageMetadata.entityId, entityId), eq(messageMetadata.userId, userId)),
      );

    // Charge only now that the summary exists and is stored.
    const charged = await incrementDailyLimit(userId, session.user.email, userTimeZone);
    if (!charged) {
      // Raced past the limit while generating. The summary is already saved
      // and cached, so surface it rather than throwing away work the user
      // will otherwise be charged for on the next attempt.
      console.warn("[api:summarize] limit hit during generation", { userId, entityId });
    }

    return NextResponse.json({
      summary: result.summary,
      digest: result.digest,
      fullText: result.fullText,
      meta: result.analysis,
      flags,
      cached: false,
    });
  } catch (error) {
    console.error("[api:summarize] Error generating summary:", error);
    return NextResponse.json({ error: "Failed to generate summary" }, { status: 500 });
  }
}
