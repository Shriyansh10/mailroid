import { db, desc, eq, and } from "../../database/index.ts";
import { conversations, assistantMessages, pendingApprovals } from "../../database/schema.ts";
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
import { registerProductionExecutors } from "../../../apps/web/lib/executors/index.ts";
import crypto from "node:crypto";

const registry = new ToolRegistry();
registerProductionExecutors(registry);
const permissions = new PermissionService();
const audit = new ConsoleAuditLogger();
const orchestrator = new ToolOrchestrator(registry, permissions, audit);

async function main() {
  console.log("Finding the latest executed approval...");
  const [approval] = await db
    .select()
    .from(pendingApprovals)
    .where(eq(pendingApprovals.status, "EXECUTED"))
    .orderBy(desc(pendingApprovals.createdAt))
    .limit(1);

  if (!approval) {
    console.log("No pending approvals found.");
    process.exit(0);
  }

  console.log("Found pending approval:", JSON.stringify(approval, null, 2));

  // Load conversation messages
  const convMessages = await db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, approval.requestId)) // wait, check if requestId is conversationId or if we can get it
    .orderBy(assistantMessages.createdAt);

  // Let's find the conversation containing this approval's toolCallId
  const allMessages = await db.select().from(assistantMessages);
  let conversationId = "";
  for (const m of allMessages) {
    if (m.toolCalls && Array.isArray(m.toolCalls)) {
      if (m.toolCalls.some((tc: any) => tc.id === approval.toolCallId)) {
        conversationId = m.conversationId;
        break;
      }
    }
  }

  if (!conversationId) {
    console.log("Could not find conversation for toolCallId:", approval.toolCallId);
    process.exit(1);
  }

  console.log("Found conversationId:", conversationId);

  const msgs = await db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(assistantMessages.createdAt);

  console.log(`Loaded ${msgs.length} messages from DB.`);

  // Simulate frontend filtering and mapping
  const apiMessages = [
    {
      role: "system" as const,
      content: "You are Dobbie, a helpful executive assistant. Be concise and professional.",
    },
    ...msgs
      .filter((m) => {
        // Simulating: msg.role === 'assistant' && msg.toolCalls matches pending approvals => filtered out
        // Wait, on frontend it filters out if msg has approvalRequired
        // Let's filter out if it contains our active pending toolCallId
        if (m.toolCalls && Array.isArray(m.toolCalls)) {
          if (m.toolCalls.some((tc: any) => tc.id === approval.toolCallId)) {
            return false;
          }
        }
        return m.role === "user" || m.role === "assistant";
      })
      .map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content || "",
      })),
  ];

  console.log("API messages count for resume:", apiMessages.length);

  // Execute tool
  console.log("Executing tool...");
  const result = await orchestrator.executeTool(
    approval.toolName,
    approval.args as Record<string, unknown>,
    approval.userId,
    crypto.randomUUID(),
    true
  );
  console.log("Tool execution result:", result);

  // Resume DeepSeek
  console.log("Resuming DeepSeek...");
  const rawConversation: any[] = [
    ...apiMessages,
    {
      role: "assistant" as const,
      content: null,
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

  const conversation = healConversation(rawConversation);
  console.log("Conversation sent to DeepSeek:", JSON.stringify(conversation, null, 2));

  try {
    const toolDefs = toOpenAiToolDefs(registry);
    const completion = await deepseek.chat.completions.create({
      model: DEEPSEEK_CHAT_MODEL,
      messages: conversation,
      stream: false as const,
      ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
    } as any);

    const msg = completion.choices[0]?.message;
    console.log("DeepSeek completion message:", JSON.stringify(msg, null, 2));
  } catch (err: any) {
    console.error("DeepSeek resumption failed with error:", err);
  }
}

main().catch(console.error);
