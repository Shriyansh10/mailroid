import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db } from "@repo/database";
import {
  ToolRegistry,
  PermissionService,
  ConsoleAuditLogger,
  ToolOrchestrator,
  deepseek,
  DEEPSEEK_CHAT_MODEL,
  toOpenAiToolDefs,
} from "@repo/ai";
import { DrizzleApprovalStore } from "@web/lib/approval-store";
import { registerProductionExecutors } from "@web/lib/executors/index";
import crypto from "node:crypto";

export const runtime = "nodejs";

// ── Singletons (shared with chat route — same store + orchestrator) ──

const registry = new ToolRegistry();
registerProductionExecutors(registry);
const permissions = new PermissionService();
const audit = new ConsoleAuditLogger();
const approvalStore = new DrizzleApprovalStore(db);
const orchestrator = new ToolOrchestrator(registry, permissions, audit, approvalStore);

/**
 * POST /api/approvals/approve
 *
 * Body: { approvalId: string, messages?: ChatMessage[] }
 *
 * Flow:
 *   1. Load pending approval from DB
 *   2. Mark APPROVED
 *   3. Execute tool via orchestrator
 *   4. Mark EXECUTED
 *   5. Resume conversation: push tool_call + tool_result → DeepSeek final
 *   6. Return ChatResponse
 */
export async function POST(request: Request) {
  try {
    // ── Auth ───────────────────────────────────────────────────────
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // ── Parse body ─────────────────────────────────────────────────
    let body: {
      approvalId: string;
      messages?: { role: string; content: string }[];
      reasoningContent?: string | null;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.approvalId) {
      return NextResponse.json({ error: "approvalId is required" }, { status: 400 });
    }

    // ── Load pending approval ──────────────────────────────────────
    const approval = await approvalStore.get(body.approvalId);
    if (!approval) {
      return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }

    if (approval.status !== "PENDING") {
      return NextResponse.json(
        { error: `Approval already ${approval.status.toLowerCase()}` },
        { status: 409 },
      );
    }

    if (approval.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // ── Mark APPROVED ──────────────────────────────────────────────
    await approvalStore.update(body.approvalId, {
      status: "APPROVED",
      approvedAt: new Date(),
    });

    // ── Execute tool ───────────────────────────────────────────────
    const requestId = crypto.randomUUID();
    const result = await orchestrator.executeTool(
      approval.toolName,
      approval.args as Record<string, unknown>,
      userId,
      requestId,
      true, // skipPermissionCheck — approval already granted
    );

    // ── Resume conversation if messages provided ────────────────────
    let finalContent = `Tool "${approval.toolName}" executed: ${result.status}`;

    if (body.messages && body.messages.length > 0) {
      try {
        // Rebuild conversation history. Messages from the frontend are
        // ChatMessage[] (role + content only). We append the original
        // tool_call (so DeepSeek sees the proper tool-calling context)
        // and the tool result.
        const conversation: unknown[] = [
          ...body.messages.map((m) => ({
            role: m.role as "system" | "user" | "assistant",
            content: m.content,
          })),
          {
            role: "assistant" as const,
            content: null,
            reasoning_content: body.reasoningContent ?? "",
            tool_calls: [
              {
                id: approval.toolCallId,
                type: "function" as const,
                function: {
                  name: approval.toolName,
                  arguments: JSON.stringify(approval.args as Record<string, unknown>),
                },
              },
            ],
          },
          {
            role: "tool" as const,
            tool_call_id: approval.toolCallId,
            content:
              result.status === "success"
                ? JSON.stringify(result.data)
                : JSON.stringify({ error: result.error ?? "Tool execution failed" }),
          },
        ];

        // Include tools so DeepSeek can call remaining tools (e.g. sendEmail
        // after createEvent was approved)
        const toolDefs = toOpenAiToolDefs(registry);

        const completion = await deepseek.chat.completions.create({
          model: DEEPSEEK_CHAT_MODEL,
          messages: conversation,
          stream: false as const,
          ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
        } as Parameters<typeof deepseek.chat.completions.create>[0]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = (completion as any).choices[0]?.message;

        // If DeepSeek wants to call another tool (e.g. sendEmail), execute it
        if (msg?.tool_calls?.length > 0) {
          const results: string[] = [];

          for (const tc of msg.tool_calls) {
            const fn = tc.function;
            if (!fn) continue;

            let args: Record<string, unknown>;
            try { args = JSON.parse(fn.arguments); } catch { args = {}; }

            console.log("[api:approvals:resume-tool]", { toolName: fn.name, args });

            const toolResult = await orchestrator.executeTool(
              fn.name,
              args,
              userId,
              crypto.randomUUID(),
              true, // skip permission — user approved the overall action
            );

            if (toolResult.status === "success") {
              results.push(`✅ ${fn.name} completed successfully.`);
            } else {
              results.push(`❌ ${fn.name} failed: ${toolResult.error ?? "unknown error"}`);
            }

            // Push tool result into conversation for final DeepSeek summary
            conversation.push({
              role: "assistant" as const,
              content: null,
              tool_calls: [{ id: tc.id, type: "function", function: fn }],
            });
            conversation.push({
              role: "tool" as const,
              tool_call_id: tc.id,
              content: toolResult.status === "success"
                ? JSON.stringify(toolResult.data)
                : JSON.stringify({ error: toolResult.error }),
            });
          }

          // One more DeepSeek call for a final summary (no tools this time)
          try {
            const summary = await deepseek.chat.completions.create({
              model: DEEPSEEK_CHAT_MODEL,
              messages: conversation,
              stream: false as const,
            } as Parameters<typeof deepseek.chat.completions.create>[0]);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            finalContent = (summary as any).choices[0]?.message?.content ?? results.join("\n");
          } catch {
            finalContent = results.join("\n");
          }
        } else {
          finalContent = msg?.content ?? finalContent;
        }
      } catch (err) {
        console.warn("[api:approvals:approve:resume-failed]", {
          error: err instanceof Error ? err.message : String(err),
        });
        // Tool already executed — don't fail the request, just use the summary
      }
    }

    // ── Mark EXECUTED (after DeepSeek call to avoid losing state on error) ──
    await approvalStore.update(body.approvalId, {
      status: "EXECUTED",
      executedAt: new Date(),
    });

    return NextResponse.json({ role: "assistant", content: finalContent });
  } catch (error) {
    console.error("[api:approvals:approve:error]", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Approval request failed" }, { status: 500 });
  }
}
