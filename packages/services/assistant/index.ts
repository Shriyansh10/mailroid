import { db, eq, and, isNull, desc, asc } from "@repo/database";
import { conversations, assistantMessages, pendingApprovals } from "@repo/database/schema";

export async function listConversations(userId: string) {
  return await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt)
      )
    )
    .orderBy(desc(conversations.updatedAt));
}

export async function getMessages(userId: string, conversationId: string) {
  // 1. Verify ownership
  const [conv] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt)
      )
    )
    .limit(1);

  if (!conv) {
    throw new Error("Conversation not found");
  }

  // 2. Fetch messages
  const messagesResult = await db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(asc(assistantMessages.createdAt));

  // 3. Fetch pending approvals
  const approvals = await db
    .select()
    .from(pendingApprovals)
    .where(
      and(
        eq(pendingApprovals.userId, userId),
        eq(pendingApprovals.status, "PENDING")
      )
    );

  const approvalMap = new Map(approvals.map((app) => [app.toolCallId, app]));

  // 4. Map and attach approvals
  return messagesResult.map((msg) => {
    let approvalRequired: any = undefined;
    if (msg.role === "assistant" && Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        const pendingApp = approvalMap.get(tc.id);
        if (pendingApp) {
          approvalRequired = {
            approvalId: pendingApp.id,
            toolName: pendingApp.toolName,
            toolCallId: pendingApp.toolCallId,
            args: pendingApp.args || {},
            preview: pendingApp.preview || `Run ${pendingApp.toolName}`,
            reasoningContent: null,
          };
          break;
        }
      }
    }

    return {
      id: msg.id,
      conversationId: msg.conversationId,
      role: msg.role as "user" | "assistant" | "tool",
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolCallId: msg.toolCallId,
      createdAt: msg.createdAt,
      approvalRequired,
    };
  });
}

export async function deleteConversation(userId: string, conversationId: string) {
  await db
    .update(conversations)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId)
      )
    );
  return { success: true };
}
