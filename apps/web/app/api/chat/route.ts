import { NextResponse } from "next/server";
import { sendChat, ChatRequestSchema } from "@repo/ai";

export const runtime = "nodejs";

/**
 * POST /api/chat
 *
 * Accepts a JSON body with { messages: [{ role, content }] } and returns
 * the DeepSeek assistant response.
 *
 * Phase 0: no auth, no tool calling, no Gmail/Calendar integration.
 */
export async function POST(request: Request) {
  const start = Date.now();

  try {
    // ── Parse & validate ──────────────────────────────────────────
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // ── Call DeepSeek ─────────────────────────────────────────────
    const response = await sendChat(parsed.data.messages);

    console.log("[api:chat:success]", {
      durationMs: Date.now() - start,
      messageCount: parsed.data.messages.length,
      responseLen: response.content.length,
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error("[api:chat:error]", {
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      { error: "Chat request failed" },
      { status: 500 },
    );
  }
}
