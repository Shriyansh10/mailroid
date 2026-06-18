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

    // ── Jailbreak scan on user messages ───────────────────────────
    const lastUserMessage = [...parsed.data.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMessage) {
      const injectionMatches = detectPromptInjection(lastUserMessage.content || "");
      if (injectionMatches.length > 0) {
        console.log(
          `[SECURITY] ${AuditEventType.POLICY_BYPASS_ATTEMPT} | ` +
          `user=${userId} | ` +
          `matches=${injectionMatches.length} | ` +
          `patterns=${injectionMatches.map((m) => m.pattern.slice(0, 40)).join(", ")}`,
        );
      }
    }

    // ── Ensure conversation exists ─────────────────────────────────
    let conversationId = parsed.data.conversationId;
    if (!conversationId) {
      const userText = lastUserMessage?.content || "New Chat";
      const title = userText.length > 60 ? userText.slice(0, 57) + "..." : userText;

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
    if (lastUserMessage) {
      await db.insert(assistantMessages).values({
        conversationId,
        role: "user",
        content: lastUserMessage.content || "",
      });
    }

    const userTimeZone = request.headers.get("x-user-timezone") || undefined;

    // ── Run agent loop (DeepSeek + tool calling) ───────────────────
    const { response, newMessages } = await runAgentLoop({
      messages: parsed.data.messages,
      registry,
      execute: (name, args) =>
        orchestrator.executeTool(name, args, userId, crypto.randomUUID(), false, userTimeZone, session.user.email),
      userId,
    });

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
      messageCount: parsed.data.messages.length,
      responseLen: response.content.length,
      approvalRequired: "approvalRequired" in response ? response.approvalRequired.toolName : undefined,
    });

    return NextResponse.json({
      ...response,
      conversationId,
      newMessages,
    });
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
