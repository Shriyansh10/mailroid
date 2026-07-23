import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db } from "@repo/database";
import { conversations, assistantMessages } from "@repo/database/schema";
import { getOrCreateSummary } from "@web/lib/summarize/get-or-create-summary";

export const runtime = "nodejs";

/**
 * POST /api/chat/seed — "Discuss with Dobbie" hand-off.
 *
 * Replaces the old sessionStorage + synthetic-client-history mechanism
 * (apps/web/lib/dobbie-seed.ts, deleted). That approach had two problems:
 *
 * 1. The synthetic tool round-trip only lived in the browser's request
 *    payload — /api/chat never persisted it, so the email context vanished
 *    from turn 2 onward the moment the DB-backed message list reloaded.
 * 2. The client could POST a fabricated `role:"tool"` message claiming an
 *    email said anything, and the model would treat it as real tool output.
 *
 * This route builds the same "assistant called summarizeEmail" round-trip,
 * but server-side, from a real (re-verified) summary, and persists it before
 * the client ever sees a conversationId — so both problems are structural
 * non-issues rather than things to be careful about.
 */
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let body: { entityId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const entityId = body.entityId?.trim();
    if (!entityId) {
      return NextResponse.json({ error: "entityId is required" }, { status: 400 });
    }

    const userTimeZone = request.headers.get("x-user-timezone") || undefined;

    // Re-derives the summary (or hits cache — true almost always, since the
    // inbox card already summarized this email before the button appears)
    // rather than trusting anything the client might supply about it.
    const outcome = await getOrCreateSummary({
      userId,
      userEmail: session.user.email,
      entityId,
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
      };
      return NextResponse.json({ error: outcome.message }, { status: statusByReason[outcome.reason] ?? 500 });
    }

    const subject = outcome.subject || "(no subject)";
    const sender = outcome.sender || "Unknown sender";
    const toolCallId = `seed-${outcome.entityId}`;

    const toolResultPayload = {
      found: true,
      entityId: outcome.entityId,
      threadId: outcome.threadId,
      subject: outcome.subject,
      sender: outcome.sender,
      receivedAt: outcome.receivedAt,
      // Matches the summarizeEmail tool's own field convention: "summary" is
      // the full digest (the model's working context), "overview" the short
      // version. See apps/web/lib/executors/summarize.ts.
      summary: outcome.digest,
      overview: outcome.summary,
      guardrails: outcome.flags,
    };

    const conversationId = await db.transaction(async (tx) => {
      const [conv] = await tx
        .insert(conversations)
        .values({
          userId,
          title: subject.length > 60 ? subject.slice(0, 57) + "..." : subject,
        })
        .returning({ id: conversations.id });
      if (!conv) throw new Error("Failed to create conversation");

      await tx.insert(assistantMessages).values([
        {
          conversationId: conv.id,
          role: "user",
          content: `Let's discuss this email: "${subject}" from ${sender}.`,
        },
        {
          conversationId: conv.id,
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: toolCallId,
              type: "function",
              function: { name: "summarizeEmail", arguments: JSON.stringify({ entityId: outcome.entityId }) },
            },
          ],
        },
        {
          conversationId: conv.id,
          role: "tool",
          toolCallId,
          content: `<tool_result tool="summarizeEmail">\n${JSON.stringify(toolResultPayload)}\n</tool_result>`,
          metadata: {
            toolName: "summarizeEmail",
            emailRef: {
              entityId: outcome.entityId,
              threadId: outcome.threadId,
              subject: outcome.subject,
              sender: outcome.sender,
              receivedAt: outcome.receivedAt,
            },
          },
        },
      ]);

      return conv.id;
    });

    return NextResponse.json({ conversationId });
  } catch (error) {
    console.error("[api:chat:seed] error", error);
    return NextResponse.json({ error: "Failed to start a conversation about this email" }, { status: 500 });
  }
}
