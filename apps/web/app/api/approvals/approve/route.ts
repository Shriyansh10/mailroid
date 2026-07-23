import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db, eq } from "@repo/database";
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
import { checkDailyLimit, incrementDailyLimit } from "@web/lib/limits";
import { buildSystemPrompt } from "@web/lib/assistant/system-prompt";
import { loadConversationHistory, getActiveEmailContext, trimHistoryForModel } from "@web/lib/assistant/history";
import { deriveToolMessageMetadata } from "@web/lib/assistant/tool-memory";
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

    // ── Check Daily Action Limit ───────────────────────────────────
    const limitCheck = await checkDailyLimit(userId, session.user.email, userTimeZone);
    if (!limitCheck.allowed) {
      return NextResponse.json(
        { error: limitCheck.message },
        { status: 429 }
      );
    }

    // ── Parse body ─────────────────────────────────────────────────
    let body: {
      approvalId: string;
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
        metadata: deriveToolMessageMetadata(approval.toolName, approval.args as Record<string, unknown>, result) ?? null,
      });
    }

    // ── Resume conversation if conversationId is valid ──────────────────
    let finalContent = `Tool "${approval.toolName}" executed: ${result.status}`;

    if (conversationId) {
      try {
        // Fetch complete message history from the database, and build the
        // system prompt server-side (same helpers /api/chat uses) — this
        // route used to accept a client-supplied `messages[0]` system prompt
        // verbatim, which a crafted request could use to replace the SENDER
        // IDENTITY rules outright. Never trust it from the client again.
        const [dbMsgs, emailContext] = await Promise.all([
          loadConversationHistory(conversationId),
          getActiveEmailContext(conversationId, userId),
        ]);

        const systemPrompt = buildSystemPrompt({
          userTimeZone: userTimeZone ?? "UTC",
          userEmail: session.user.email,
          emailContext,
        });

        const trimmedHistory = trimHistoryForModel(dbMsgs);

        // Map database messages to OpenAI message format
        const rawConversation: any[] = [
          {
            role: "system" as const,
            content: systemPrompt,
          },
          ...trimmedHistory.map((m) => {
            if (m.role === "assistant") {
              return {
                role: "assistant" as const,
                content: m.content || null,
                tool_calls: m.tool_calls as any[] | undefined,
              };
            }
            if (m.role === "tool") {
              return {
                role: "tool" as const,
                tool_call_id: m.tool_call_id!,
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

        // If DeepSeek wants to call another tool (e.g. sendEmail), execute it.
        // Only tool calls actually attempted are persisted below — if one of
        // them needs its own approval (e.g. createEvent is DANGEROUS), we
        // stop there rather than force-executing it, so a second approval
        // card can be surfaced instead of silently bypassing consent.
        if (msg?.tool_calls?.length > 0) {
          const attemptedToolCalls: any[] = [];
          const toolResultInserts: any[] = [];
          const results: string[] = [];
          let approvalNeeded = false;

          for (const tc of msg.tool_calls) {
            const fn = tc.function;
            if (!fn) continue;

            let args: Record<string, unknown>;
            try { args = JSON.parse(fn.arguments); } catch { args = {}; }

            // Attach the tool call ID so the orchestrator can store it for approval
            args._toolCallId = tc.id;

            console.log("[api:approvals:resume-tool]", { toolName: fn.name, args });

            const toolResult = await orchestrator.executeTool(
              fn.name,
              args,
              userId,
              crypto.randomUUID(),
              false, // do NOT skip permission checks — this may be a new dangerous tool needing its own approval
              userTimeZone,
              session.user.email,
            );

            attemptedToolCalls.push({ id: tc.id, type: "function", function: fn });

            if (toolResult.status === "approval_required") {
              console.log("[api:approvals:resume-tool] approval required for chained call", {
                toolName: fn.name,
                approvalId: toolResult.approvalId,
                toolCallId: tc.id,
              });
              approvalNeeded = true;
              break;
            }

            if (toolResult.status === "success") {
              results.push(`✅ ${fn.name} completed successfully.`);
            } else {
              results.push(`❌ ${fn.name} failed: ${toolResult.error ?? "unknown error"}`);
            }

            if (conversationId) {
              toolResultInserts.push({
                conversationId,
                role: "tool",
                toolCallId: tc.id,
                content: toolResult.status === "success"
                  ? JSON.stringify(toolResult.data)
                  : JSON.stringify({ error: toolResult.error }),
                metadata: deriveToolMessageMetadata(fn.name, args, toolResult) ?? null,
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

          if (conversationId) {
            newMessagesToInsert.push({
              conversationId,
              role: "assistant",
              content: msg.content ?? null,
              toolCalls: attemptedToolCalls,
            });
            newMessagesToInsert.push(...toolResultInserts);
          }

          if (approvalNeeded) {
            // A chained tool call needs its own approval — surface that
            // instead of summarizing, and stop here (no forced execution).
            finalContent = msg.content ?? "I'd like to perform another action. Please approve it.";
          } else {
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

    // ── Increment Daily Limit (charge successful action only) ──────
    let shouldCharge = result.status === "success";
    if (shouldCharge) {
      for (const m of newMessagesToInsert) {
        if (m.role === "tool" && m.content) {
          try {
            const parsed = JSON.parse(m.content);
            if (parsed && typeof parsed === "object" && "error" in parsed) {
              shouldCharge = false;
              break;
            }
          } catch {
            // Ignore JSON parse errors
          }
        }
      }

      if (shouldCharge && finalContent) {
        const lowerContent = finalContent.toLowerCase();
        if (
          lowerContent.includes("only authorized to send") ||
          lowerContent.includes("only authorized to schedule") ||
          lowerContent.includes("cannot impersonate") ||
          lowerContent.includes("only authorized to create")
        ) {
          shouldCharge = false;
        }
      }
    }

    if (shouldCharge) {
      const incrementSuccess = await incrementDailyLimit(userId, session.user.email, userTimeZone);
      if (!incrementSuccess) {
        return NextResponse.json(
          { error: "Daily limit reached during concurrent processing." },
          { status: 429 }
        );
      }
    }

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
