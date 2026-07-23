import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db, eq, and, sql } from "@repo/database";
import { conversations, assistantMessages, pendingApprovals } from "@repo/database/schema";
import {
  ChatRequestSchema,
  ToolRegistry,
  PermissionService,
  ConsoleAuditLogger,
  ToolOrchestrator,
  runAgentLoop,
  detectPromptInjection,
  AuditEventType,
  deepseek,
  DEEPSEEK_CHAT_MODEL,
  MODEL_CONTEXT_WINDOW_TOKENS,
  type ChatMessage,
} from "@repo/ai";
import { DrizzleApprovalStore } from "@web/lib/approval-store";
import { registerProductionExecutors } from "@web/lib/executors/index";
import { checkDailyLimit, incrementDailyLimit } from "@web/lib/limits";
import { buildSystemPrompt } from "@web/lib/assistant/system-prompt";
import { loadConversationHistory, getActiveEmailContext, trimHistoryForModel } from "@web/lib/assistant/history";
import { deriveToolMessageMetadata } from "@web/lib/assistant/tool-memory";
import { getProtectedConfig } from "@repo/services/profile/index";
import { matchProtectedKeyword } from "@repo/shared";

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
 * Server-authoritative: the client sends only { conversationId?, message }.
 * Conversation history and the system prompt are both built here, from the
 * database and the authenticated session — never from client input. The
 * client used to send the full message array AND a self-built system
 * prompt (as messages[0]), and both this route and /api/approvals/approve
 * trusted it verbatim; a crafted POST could replace the SENDER IDENTITY
 * rules or forge a fake tool result. See apps/web/lib/assistant/.
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

    const userMessageText = parsed.data.message;

    // ── Jailbreak scan on the incoming user message ────────────────
    const injectionMatches = detectPromptInjection(userMessageText);
    if (injectionMatches.length > 0) {
      console.log(
        `[SECURITY] ${AuditEventType.POLICY_BYPASS_ATTEMPT} | ` +
        `user=${userId} | ` +
        `matches=${injectionMatches.length} | ` +
        `patterns=${injectionMatches.map((m) => m.pattern.slice(0, 40)).join(", ")}`,
      );
    }

    // ── Ensure conversation exists ─────────────────────────────────
    let conversationId = parsed.data.conversationId;
    if (!conversationId) {
      const title = userMessageText.length > 60 ? userMessageText.slice(0, 57) + "..." : userMessageText;

      const [newConv] = await db
        .insert(conversations)
        .values({
          userId,
          title,
        })
        .returning({ id: conversations.id });
      if (!newConv) {
        throw new Error("Failed to create conversation");
      }
      conversationId = newConv.id;
    }

    // ── Auto-resolve abandoned pending approvals in this conversation ──
    if (conversationId) {
      // 1. Fetch pending approvals for the active user
      const pending = await db
        .select()
        .from(pendingApprovals)
        .where(
          and(
            eq(pendingApprovals.userId, userId),
            eq(pendingApprovals.status, "PENDING")
          )
        );

      if (pending.length > 0) {
        // 2. Fetch all assistant messages in the active conversation that have toolCalls
        const convMessages = await db
          .select({ toolCalls: assistantMessages.toolCalls })
          .from(assistantMessages)
          .where(
            and(
              eq(assistantMessages.conversationId, conversationId),
              sql`${assistantMessages.toolCalls} IS NOT NULL`
            )
          );

        const convToolCallIds = new Set(
          convMessages.flatMap((msg) =>
            Array.isArray(msg.toolCalls)
              ? msg.toolCalls.map((tc: any) => tc.id as string).filter(Boolean)
              : []
          )
        );

        // 3. Cancel matching pending approvals and write terminal messages
        for (const p of pending) {
          if (convToolCallIds.has(p.toolCallId)) {
            console.log(`[api:chat] Abandoned approval found: ${p.id}. Cancelling and writing terminal tool message.`);

            await db
              .update(pendingApprovals)
              .set({
                status: "CANCELLED",
                cancelledAt: new Date(),
              })
              .where(eq(pendingApprovals.id, p.id));

            await db.insert(assistantMessages).values({
              conversationId,
              role: "tool",
              toolCallId: p.toolCallId,
              content: JSON.stringify({ error: "Action cancelled or ignored by user" }),
              metadata: { status: "cancelled" },
            });
          }
        }
      }
    }

    // ── Persist incoming user prompt ──────────────────────────────
    await db.insert(assistantMessages).values({
      conversationId,
      role: "user",
      content: userMessageText,
    });

    const userTimeZone = request.headers.get("x-user-timezone") || undefined;

    // ── Protected-keyword short-circuit ─────────────────────────────
    // If the user's own message mentions a protected keyword (e.g. "otp"),
    // refuse deterministically here instead of running the agent loop —
    // search would silently strip matching emails anyway, and relying on
    // the model to notice and disclose that clearly is unreliable (it has
    // padded refusals with unrelated results in the past). See BUGS.md.
    const protectedConfig = await getProtectedConfig(userId);
    const matchedKeyword = matchProtectedKeyword(userMessageText, protectedConfig.keywords);
    if (matchedKeyword) {
      const refusal =
        "That relates to content on your protected list, so I can't search for or show it. " +
        "You can review or edit your protected keywords in Settings → Personalization.";

      await db.insert(assistantMessages).values({
        conversationId,
        role: "assistant",
        content: refusal,
      });

      await db
        .update(conversations)
        .set({ lastMessagePreview: refusal.slice(0, 100), updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));

      return NextResponse.json({
        content: refusal,
        conversationId,
        newMessages: [{ role: "assistant", content: refusal }],
      });
    }

    // ── Check Daily Action Limit ───────────────────────────────────
    const limitCheck = await checkDailyLimit(userId, session.user.email, userTimeZone);
    if (!limitCheck.allowed) {
      return NextResponse.json(
        { error: limitCheck.message },
        { status: 429 }
      );
    }

    // ── Build the model's view of the conversation, server-side ────
    const [history, emailContext] = await Promise.all([
      loadConversationHistory(conversationId),
      getActiveEmailContext(conversationId, userId),
    ]);

    const systemPrompt = buildSystemPrompt({ userTimeZone: userTimeZone ?? "UTC", userEmail: session.user.email, emailContext });
    const trimmedHistory = trimHistoryForModel(history);

    const agentMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...trimmedHistory.map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls as any,
        tool_call_id: m.tool_call_id,
      })),
    ];

    // ── Run agent loop (DeepSeek + tool calling) ───────────────────
    const { response, newMessages, contextChars } = await runAgentLoop({
      messages: agentMessages,
      registry,
      execute: (name, args) =>
        orchestrator.executeTool(name, args, userId, crypto.randomUUID(), false, userTimeZone, session.user.email),
      userId,
      deriveToolMessageMetadata,
    });

    // ── Context-window usage, for the assistant UI's indicator ─────
    // Measured against the model's real context window (gpt-4o-mini, 128K
    // tokens — see MODEL_CONTEXT_WINDOW_TOKENS). Note this is much larger
    // than the ~60K-char budget trimHistoryForModel actually enforces, so
    // this bar will usually read low even when older turns have already
    // started getting trimmed from what the model sees — it answers "how
    // full is the model's real window", not "has trimming kicked in yet".
    // ~4 chars/token is the standard rough estimate for English text.
    const contextUsedTokens = Math.ceil(contextChars / 4);
    const contextUsage = {
      usedTokens: contextUsedTokens,
      maxTokens: MODEL_CONTEXT_WINDOW_TOKENS,
      percentUsed: Math.min(100, Math.round((contextUsedTokens / MODEL_CONTEXT_WINDOW_TOKENS) * 100)),
    };

    // ── Beautification pass: convert raw tables to natural language ──
    if (!("approvalRequired" in response) && response.content) {
      response.content = await beautifyResponse(response.content);
    }

    // Update the content of the assistant message in newMessages if it was beautified
    const finalAssistantMsg = [...newMessages].reverse().find((m) => m.role === "assistant");
    if (finalAssistantMsg && !("approvalRequired" in response)) {
      finalAssistantMsg.content = response.content;
    }

    // ── Persist all generated loop messages in bulk ────────────────
    if (newMessages.length > 0) {
      await db.insert(assistantMessages).values(
        newMessages.map((m) => ({
          conversationId,
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
          toolCallId: m.toolCallId,
          metadata: m.metadata ?? null,
        }))
      );
    }

    // ── Update conversation preview and updatedAt ──────────────────
    const previewContent = response.content || "";
    const lastMessagePreview = previewContent.length > 100 ? previewContent.slice(0, 97) + "..." : previewContent;

    await db
      .update(conversations)
      .set({
        lastMessagePreview,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    console.log("[api:chat:success]", {
      durationMs: Date.now() - start,
      historyMessageCount: trimmedHistory.length,
      responseLen: response.content.length,
      approvalRequired: "approvalRequired" in response ? response.approvalRequired.toolName : undefined,
    });

    // ── Increment Daily Limit (charge successful action only) ──────
    let shouldCharge = !("approvalRequired" in response);
    if (shouldCharge) {
      // If any tool call returned a tool_error, we do not charge
      const hasToolError = newMessages.some(
        (m) => m.role === "tool" && m.content && m.content.includes("<tool_error")
      );
      if (hasToolError) {
        shouldCharge = false;
      }

      // Check if response is a cognitive refusal for sender identity / organizer rules
      if (response.content) {
        const lowerContent = response.content.toLowerCase();
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
      ...response,
      conversationId,
      newMessages,
      contextUsage,
    });
  } catch (error) {
    console.error("[api:chat:error]", {
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      // DeepSeek/OpenAI SDK errors carry the real reason (context length,
      // rate limit, etc.) in these fields, not in `.message`.
      status: (error as { status?: number })?.status,
      body: (error as { error?: unknown })?.error,
    });

    return NextResponse.json(
      { error: "Chat request failed" },
      { status: 500 },
    );
  }
}

// ── Beautification helpers ───────────────────────────────────────────

/**
 * Post-process agent output to convert raw markdown tables into
 * natural conversational English.
 *
 * Only runs when the response contains table-like syntax (| pipes).
 * Makes a lightweight LLM call with no tools to naturalize the text.
 */
async function beautifyResponse(rawContent: string): Promise<string> {
  // Quick check: does it look like a raw table/data dump?
  if (!looksLikeRawTable(rawContent)) {
    return rawContent;
  }

  console.log("[beautify] detected raw table, running beautification pass");

  try {
    const completion = await deepseek.chat.completions.create({
      model: DEEPSEEK_CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: [
            "You are a response beautifier. Your job is to convert raw data/tables into natural conversational English.",
            "",
            "RULES:",
            "- NEVER output markdown tables, pipe characters, or structured data.",
            "- Always respond in natural conversational paragraphs.",
            "- Preserve ALL information from the original — just reformat it.",
            "- Use plain bullet points (- item) for lists, never tables.",
            "- Be warm and helpful in tone.",
            "- NEVER add information not present in the original.",
          ].join("\n"),
        },
        {
          role: "user",
          content: `Convert this raw assistant response into natural conversational English:\n\n${rawContent}`,
        },
      ],
      stream: false,
      temperature: 0.3,
      max_tokens: 1000,
    });

    const beautified = completion.choices[0]?.message?.content;
    if (beautified) {
      console.log("[beautify] done, before:", rawContent.length, "after:", beautified.length);
      return beautified;
    }
  } catch (error) {
    console.warn("[beautify] failed, returning raw content:",
      error instanceof Error ? error.message : String(error));
  }

  return rawContent;
}

/** Detect if text contains markdown table syntax or looks like a raw data dump. */
function looksLikeRawTable(content: string): boolean {
  // Contains markdown table pipes with header separator (|---|---|)
  const hasTableSeparator = /\|[\s-]+\|/.test(content);
  // Or contains multiple pipe characters suggesting tabular data
  const pipeCount = (content.match(/\|/g) ?? []).length;
  // Or looks like a numbered list with structured columns
  const hasNumberedTable = /\|\s*\d+\s*\|/.test(content);

  return hasTableSeparator || pipeCount >= 6 || hasNumberedTable;
}
