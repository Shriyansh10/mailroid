import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db } from "@repo/database";
import {
  ChatRequestSchema,
  ToolRegistry,
  PermissionService,
  ConsoleAuditLogger,
  ToolOrchestrator,
  runAgentLoop,
} from "@repo/ai";
import { DrizzleApprovalStore } from "@web/lib/approval-store";
import { registerProductionExecutors } from "@web/lib/executors/index";

export const runtime = "nodejs";

// ── Singletons ──────────────────────────────────────────────────────

const registry = new ToolRegistry();
registerProductionExecutors(registry);
const permissions = new PermissionService();
const audit = new ConsoleAuditLogger();
const approvalStore = new DrizzleApprovalStore(db);
const orchestrator = new ToolOrchestrator(registry, permissions, audit, approvalStore);

/**
 * POST /api/chat
 *
 * Accepts a JSON body with { messages: [{ role, content }] } and returns
 * the DeepSeek assistant response.
 *
 * Tool calling is enabled: the agent loop runs DeepSeek with the full tool
 * registry, executes tool calls through the orchestrator (permission checks,
 * audit logging), and feeds results back until DeepSeek produces a final
 * text response.
 *
 * Auth: reads the Better Auth session cookie from the incoming request.
 * Returns 401 if no valid session is found.
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

    // ── Resolve userId from Better Auth session cookie ─────────────
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    console.log("[api:chat] authenticated userId:", userId);

    // ── Run agent loop (DeepSeek + tool calling) ───────────────────
    const response = await runAgentLoop({
      messages: parsed.data.messages,
      registry,
      execute: (name, args) =>
        orchestrator.executeTool(name, args, userId, crypto.randomUUID()),
      userId,
    });

    console.log("[api:chat:success]", {
      durationMs: Date.now() - start,
      messageCount: parsed.data.messages.length,
      responseLen: response.content.length,
      approvalRequired: "approvalRequired" in response ? response.approvalRequired.toolName : undefined,
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
