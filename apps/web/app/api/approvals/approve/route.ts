import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db, eq, asc } from "@repo/database";
import { conversations, assistantMessages } from "@repo/database/schema";
import {
  ToolRegistry,
  PermissionService,
  ConsoleAuditLogger,
  ToolOrchestrator,
  deepseek,
  DEEPSEEK_CHAT_MODEL,
  toOpenAiToolDefs,
  healConversation,
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
 */
export async function POST(request: Request) {
  try {
    const userTimeZone = request.headers.get("x-user-timezone") || undefined;

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
      conversationId?: string | null;
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

    if (approval.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // ── Expiry check ──────────────────────────────────────────────
    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      return NextResponse.json(
        { error: "Approval has expired" },
        { status: 410 },
      );
    }

    // ── Atomic single-use: only succeeds if still PENDING ──────────
    const claimed = await approvalStore.useOnce(body.approvalId);
    if (!claimed) {
      return NextResponse.json(
        { error: "Approval already consumed (replay blocked)" },
        { status: 409 },
      );
    }

    // ── Execute tool ───────────────────────────────────────────────
    const requestId = crypto.randomUUID();
    const result = await orchestrator.executeTool(
      approval.toolName,
      approval.args as Record<string, unknown>,
      userId,
      requestId,
      true, // skipPermissionCheck — approval already granted
      userTimeZone,
      session.user.email,
    );

    const conversationId = body.conversationId;
    const newMessagesToInsert: any[] = [];

    // Persist the executed tool's result to assistant_messages immediately
    if (conversationId) {
      await db.insert(assistantMessages).values({
        conversationId,
        role: "tool",
        toolCallId: approval.toolCallId,
        content: result.status === "success"
          ? JSON.stringify(result.data)
          : JSON.stringify({ error: result.error ?? "Tool execution failed" }),
      });
    }

    // ── Resume conversation if conversationId is valid ──────────────────
    let finalContent = `Tool "${approval.toolName}" executed: ${result.status}`;

    if (conversationId) {
      try {
        // Fetch complete message history from the database
        const dbMsgs = await db
          .select()
          .from(assistantMessages)
          .where(eq(assistantMessages.conversationId, conversationId))
          .orderBy(asc(assistantMessages.createdAt));

        // Resolve system prompt from frontend body if present, or use default fallback
        let systemPrompt = [
          `You are Dobbie, an AI executive assistant for email, calendar, and productivity workflows.`,
          `Be concise, professional, accurate, and action-oriented.`,
          `Never invent emails, events, people, dates, or tool results.`,
          ``,
          `SENDER IDENTITY RULES (CRITICAL):`,
          `- You may ONLY send email from the currently authenticated Gmail account: ${session?.user?.email || "unknown"}.`,
          `- You may ONLY create calendar events from the currently authenticated Google Calendar account: ${session?.user?.email || "unknown"}.`,
          `- If the user explicitly requests to send an email, schedule a meeting, or perform an action "from X", "as X", or "on behalf of X" (where X is not the authenticated email "${session?.user?.email || "unknown"}"):`,
          `  1. Do NOT call any tool under any circumstances.`,
          `  2. Explain that you cannot impersonate another account. You MUST include this exact message or a clear variation: "I am only authorized to send/schedule on your behalf." (or for email: "I am only authorized to send a mail on your behalf.")`,
          `  3. Ask whether they want to perform the action from their connected account instead.`,
          `- Do NOT refuse standard requests where the user doesn't specify a different sender/organizer (e.g. "Send email to bob@example.com" or "Schedule a meeting with Bob"). These are normal actions, and you should perform them from the authenticated account.`,
        ].join("\n");
        if (body.messages && body.messages[0]?.role === "system") {
          systemPrompt = body.messages[0].content;
        }

        // Map database messages to OpenAI message format
        const rawConversation: any[] = [
          {
            role: "system" as const,
            content: systemPrompt,
          },
          ...dbMsgs.map((m) => {
            if (m.role === "assistant") {
              return {
                role: "assistant" as const,
                content: m.content || null,
                tool_calls: m.toolCalls as any[] | undefined,
              };
            }
            if (m.role === "tool") {
              return {
                role: "tool" as const,
                tool_call_id: m.toolCallId!,
                content: m.content || "",
              };
            }
            return {
              role: m.role as "user",
              content: m.content || "",
            };
          }),
        ];

        const conversation = healConversation(rawConversation);

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
          if (conversationId) {
            newMessagesToInsert.push({
              conversationId,
              role: "assistant",
              content: msg.content ?? null,
              toolCalls: msg.tool_calls.map((tc: any) => ({
                id: tc.id,
                type: "function",
                function: tc.function,
              })),
            });
          }

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
              userTimeZone,
              session.user.email,
            );

            if (toolResult.status === "success") {
              results.push(`✅ ${fn.name} completed successfully.`);
            } else {
              results.push(`❌ ${fn.name} failed: ${toolResult.error ?? "unknown error"}`);
            }

            if (conversationId) {
              newMessagesToInsert.push({
                conversationId,
                role: "tool",
                toolCallId: tc.id,
                content: toolResult.status === "success"
                  ? JSON.stringify(toolResult.data)
                  : JSON.stringify({ error: toolResult.error }),
              });
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
            
            if (conversationId) {
              newMessagesToInsert.push({
                conversationId,
                role: "assistant",
                content: finalContent,
              });
            }
          } catch {
            finalContent = results.join("\n");
            if (conversationId) {
              newMessagesToInsert.push({
                conversationId,
                role: "assistant",
                content: finalContent,
              });
            }
          }
        } else {
          finalContent = msg?.content ?? finalContent;
          if (conversationId && msg) {
            newMessagesToInsert.push({
              conversationId,
              role: "assistant",
              content: msg.content ?? null,
              toolCalls: msg.tool_calls || null,
            });
          }
        }
      } catch (err) {
        console.warn("[api:approvals:approve:resume-failed]", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Bulk insert newMessagesToInsert ──────────────────────────────
    if (conversationId && newMessagesToInsert.length > 0) {
      await db.insert(assistantMessages).values(newMessagesToInsert);

      const previewText = finalContent || "";
      const lastMessagePreview = previewText.length > 100 ? previewText.slice(0, 97) + "..." : previewText;

      await db
        .update(conversations)
        .set({
          lastMessagePreview,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conversationId));
    }

    // ── Mark EXECUTED (after DeepSeek call to avoid losing state on error) ──
    await approvalStore.update(body.approvalId, {
      status: "EXECUTED",
      executedAt: new Date(),
    });

    return NextResponse.json({
      role: "assistant",
      content: finalContent,
      newMessages: newMessagesToInsert,
    });
  } catch (error) {
    console.error("[api:approvals:approve:error]", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Approval request failed" }, { status: 500 });
  }
}
