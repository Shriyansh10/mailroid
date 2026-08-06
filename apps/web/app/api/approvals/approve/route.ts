import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db, eq } from "@repo/database";
import { conversations, assistantMessages } from "@repo/database/schema";
import {
  ToolRegistry,
  PermissionService,
  ConsoleAuditLogger,
  ToolOrchestrator,
  runAgentLoop,
  withAiUsage,
  firewall,
} from "@repo/ai";
import type { ChatMessage, ApprovalRequiredResponse } from "@repo/ai";
import { DrizzleApprovalStore } from "@web/lib/approval-store";
import { knownIntents } from "@repo/services/scheduling/memory";
import { registerProductionExecutors } from "@web/lib/executors/index";
import { checkDailyLimit, incrementDailyLimit } from "@web/lib/limits";
import { buildSystemPrompt } from "@web/lib/assistant/system-prompt";
import { loadConversationHistory, getActiveEmailContext, trimHistoryForModel, getLatestSlotProposal, getLatestMeetingSelection } from "@web/lib/assistant/history";
import { deriveToolMessageMetadata } from "@web/lib/assistant/tool-memory";
import { SCHEDULING_TOOLS, recordProposalOutcome } from "@web/lib/assistant/scheduling-outcome";
import { resolveEffectiveTimeZone } from "@web/lib/timezone";
import { getPriorityProfile } from "@repo/services/profile/index";
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
    // ── Auth ───────────────────────────────────────────────────────
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const userTimeZone = await resolveEffectiveTimeZone(userId, request);

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

    // ── Learning signal: did the user change the time we proposed? ──
    // Recorded here because this is the only point where both halves exist:
    // what the engine offered (the slot ledger) and what the user actually
    // approved (this approval's args). Never blocks the approval itself.
    if (result.status === "success" && conversationId && SCHEDULING_TOOLS.has(approval.toolName)) {
      void recordProposalOutcome({
        userId,
        conversationId,
        approvalId: body.approvalId,
        args: approval.args as Record<string, unknown>,
        timeZone: userTimeZone ?? "UTC",
      });
    }

    // Persist the executed tool's result to assistant_messages immediately.
    //
    // Sanitised and XML-framed exactly as the agent loop frames its own
    // results (packages/ai/src/chat/agent.ts). This row is read straight back
    // by the resume below, and it used to be written as bare JSON — so the
    // model was handed one unattributable blob starting `{"draft":false,...}`
    // among a history of tagged results, could not tell that the meeting had
    // just been booked, and re-issued the call.
    if (conversationId) {
      const safeData = firewall.sanitizeToolOutput(approval.toolName, result.data);
      await db.insert(assistantMessages).values({
        conversationId,
        role: "tool",
        toolCallId: approval.toolCallId,
        content:
          result.status === "success"
            ? `<tool_result tool="${approval.toolName}">\n${JSON.stringify(safeData)}\n</tool_result>`
            : `<tool_error tool="${approval.toolName}">\n${JSON.stringify({ error: result.error ?? "Tool execution failed" })}\n</tool_error>`,
        metadata: deriveToolMessageMetadata(approval.toolName, approval.args as Record<string, unknown>, result) ?? null,
      });
    }

    // ── Resume conversation if conversationId is valid ──────────────────
    let finalContent = `Tool "${approval.toolName}" executed: ${result.status}`;
    let approvalRequired: ApprovalRequiredResponse["approvalRequired"] | undefined;

    if (conversationId) {
      try {
        // Fetch complete message history from the database, and build the
        // system prompt server-side (same helpers /api/chat uses) — this
        // route used to accept a client-supplied `messages[0]` system prompt
        // verbatim, which a crafted request could use to replace the SENDER
        // IDENTITY rules outright. Never trust it from the client again.
        const [dbMsgs, emailContext, userIntents, profile] = await Promise.all([
          loadConversationHistory(conversationId),
          getActiveEmailContext(conversationId, userId),
          knownIntents(userId),
          getPriorityProfile(userId),
        ]);

        const systemPrompt = buildSystemPrompt({
          userTimeZone: userTimeZone ?? "UTC",
          userEmail: session.user.email,
          emailContext,
          knownIntents: userIntents,
          hasSignature: Boolean(profile?.data.signature?.enabled && profile.data.signature.text.trim()),
        });

        const trimmedHistory = trimHistoryForModel(dbMsgs);

        const agentMessages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          ...trimmedHistory.map((m) => ({
            role: m.role,
            content: m.content,
            tool_calls: m.tool_calls as any,
            tool_call_id: m.tool_call_id,
          })),
        ];

        // Resume through the same agent loop /api/chat uses, rather than the
        // single completion + one-round-of-tools this route used to hand-roll.
        // That older shape could only ever take ONE more step, so a plan like
        // "create the event, then mail the attendees, then confirm" stalled
        // after the first chained call and reported success for work it had
        // not finished. The loop also owns healing, prompt-injection auditing,
        // tool-output sanitisation and XML framing — none of which the
        // hand-rolled path applied, so approved turns were being fed back to
        // the model less safely than ordinary ones.
        //
        // skipPermissionCheck stays FALSE: this approval authorised exactly
        // one call, which already executed above. Anything the model asks for
        // now is a new action and must earn its own approval card.
        const { response, newMessages } = await withAiUsage({ userId }, () =>
          runAgentLoop({
            messages: agentMessages,
            registry,
            execute: async (name, args) => {
              // Same slot-ledger injection as /api/chat — a resumed turn must
              // be able to adjust the times already offered, not start over.
              if (name === "refineMeetingSlots") {
                const proposal = await getLatestSlotProposal(conversationId);
                // Overwritten unconditionally — see the note in /api/chat.
                args = {
                  ...args,
                  previousCandidates: proposal?.candidates ?? [],
                  timeZone: userTimeZone,
                };
              }

              // Same drift-ledger injection as /api/chat — see the note there.
              if (name === "rescheduleThreadMeeting" || name === "cancelThreadMeeting") {
                const selectionId = typeof args.selectionId === "string" ? args.selectionId : undefined;
                const selection = selectionId ? await getLatestMeetingSelection(conversationId) : undefined;
                const shown = selection?.meetings.find((m) => m.selectionId === selectionId);
                args = { ...args, expectedStart: shown?.start };
              }

              return orchestrator.executeTool(
                name,
                args,
                userId,
                crypto.randomUUID(),
                false,
                userTimeZone,
                session.user.email,
              );
            },
            userId,
            deriveToolMessageMetadata,
          }),
        );

        finalContent = response.content ?? finalContent;

        if ("approvalRequired" in response) {
          // A chained call needs its own approval — surface it so the client
          // renders a second card, instead of silently dropping the request.
          approvalRequired = response.approvalRequired;
          console.log("[api:approvals:approve:chained-approval]", {
            toolName: response.approvalRequired.toolName,
            approvalId: response.approvalRequired.approvalId,
          });
        }

        newMessagesToInsert.push(
          ...newMessages.map((m) => ({
            conversationId,
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
            toolCallId: m.toolCallId,
            metadata: m.metadata ?? null,
          })),
        );
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

    // ── Mark the outcome (after the model call, to avoid losing state on error) ──
    //
    // Branches on the actual result. This was unconditional, so a failed,
    // blocked or precheck-refused call still recorded EXECUTED — the card read
    // "Approved & Executed" for something that never happened, and nothing
    // downstream could tell a real write from an attempted one.
    if (result.status === "success") {
      await approvalStore.update(body.approvalId, {
        status: "EXECUTED",
        executedAt: new Date(),
      });
    } else {
      await approvalStore.update(body.approvalId, {
        status: "FAILED",
        executedAt: new Date(),
      });
    }

    // ── Increment Daily Limit (charge successful action only) ──────
    // A chained call still awaiting its own approval has not run yet, so this
    // turn has not produced a second billable action.
    let shouldCharge = result.status === "success" && !approvalRequired;
    if (shouldCharge) {
      for (const m of newMessagesToInsert) {
        if (m.role === "tool" && m.content) {
          // Tool results from the agent loop are XML-framed, so they are not
          // JSON and the parse below never sees them — check the frame first.
          if (m.content.includes("<tool_error")) {
            shouldCharge = false;
            break;
          }
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
      // What actually happened, so the client's optimistic update doesn't have
      // to assume success and briefly show "Executed" for a call that failed.
      approvalStatus: result.status === "success" ? "EXECUTED" : "FAILED",
      ...(result.status !== "success" ? { toolError: result.error } : {}),
      // Present when the resumed loop asked for a further dangerous action.
      // The client re-reads from the database right after, where the pending
      // row surfaces as a second approval card — this just lets it react
      // without waiting for that round-trip.
      ...(approvalRequired ? { approvalRequired } : {}),
    });
  } catch (error) {
    console.error("[api:approvals:approve:error]", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Approval request failed" }, { status: 500 });
  }
}
