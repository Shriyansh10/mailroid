import { db, eq, and, isNull, desc, asc, inArray } from "@repo/database";
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

  // 3. Extract all toolCallIds from the messages
  const toolCallIds = messagesResult
    .flatMap((msg) =>
      Array.isArray(msg.toolCalls)
        ? msg.toolCalls.map((tc: any) => tc.id as string).filter(Boolean)
        : []
    );

  let approvals: any[] = [];
  if (toolCallIds.length > 0) {
    approvals = await db
      .select()
      .from(pendingApprovals)
      .where(
        and(
          eq(pendingApprovals.userId, userId),
          inArray(pendingApprovals.toolCallId, toolCallIds)
        )
      );
  }

  const approvalMap = new Map(approvals.map((app) => [app.toolCallId, app]));

  // 4. Map and attach approvals
  return messagesResult.map((msg) => {
    let approvalRequired: any = undefined;
    if (msg.role === "assistant" && Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        const app = approvalMap.get(tc.id);
        if (app) {
          approvalRequired = {
            approvalId: app.id,
            toolName: app.toolName,
            toolCallId: app.toolCallId,
            args: app.args || {},
            preview: app.preview || `Run ${app.toolName}`,
            reasoningContent: null,
            status: app.status,
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
      metadata: msg.metadata as Record<string, unknown> | null,
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
