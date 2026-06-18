import { db } from "../packages/database/index.ts";
import { conversations, assistantMessages, pendingApprovals } from "../packages/database/schema.ts";
import { eq, desc } from "drizzle-orm";

async function main() {
  console.log("Fetching conversations...");
  const convs = await db.select().from(conversations).orderBy(desc(conversations.createdAt)).limit(5);
  console.log("Conversations:", JSON.stringify(convs, null, 2));

  for (const conv of convs) {
    console.log(`\n=== Conversation ${conv.id} (${conv.title}) ===`);
    const msgs = await db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, conv.id)).orderBy(assistantMessages.createdAt);
    console.log("Messages:");
    msgs.forEach((m) => {
      console.log(`- [${m.role}] ID: ${m.id} | Content: ${m.content} | ToolCalls: ${m.toolCalls ? JSON.stringify(m.toolCalls) : "null"} | ToolCallId: ${m.toolCallId}`);
    });

    const apps = await db.select().from(pendingApprovals).where(eq(pendingApprovals.userId, conv.userId));
    console.log("Approvals:");
    apps.forEach((a) => {
      console.log(`- Tool: ${a.toolName} | Status: ${a.status} | toolCallId: ${a.toolCallId} | ApprovalId: ${a.id}`);
    });
  }
}

main().catch(console.error);
