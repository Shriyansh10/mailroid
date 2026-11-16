import { db, and, eq, isNull } from "@repo/database";
import { conversations } from "@repo/database/schema";

/**
 * Conversation ownership for the Next.js assistant routes (/api/chat,
 * /api/approvals/approve).
 *
 * Both used to accept a client-supplied `conversationId` and read its history,
 * write into it and resume Dobbie on it without asking whose it was. The tRPC
 * side never had that gap — packages/services/assistant getMessages() checks
 * id + owner + not-deleted — and this is the same rule, so the two surfaces
 * agree on what "your conversation" means.
 *
 * Callers must run this BEFORE loading history, writing messages, invoking the
 * model or executing an approved tool, and answer a `false` with
 * CONVERSATION_NOT_FOUND: the same 404 whether the id is someone else's,
 * deleted, or never existed, so the response is no oracle for other users'
 * conversation ids.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CONVERSATION_NOT_FOUND = { error: "Conversation not found" } as const;

export async function isConversationOwnedBy(userId: string, conversationId: string): Promise<boolean> {
  // conversations.id is a uuid column: a non-uuid would make Postgres throw
  // and surface as a 500. It cannot be anyone's conversation, so it is simply
  // not found.
  if (!UUID.test(conversationId)) return false;

  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
      ),
    )
    .limit(1);

  return Boolean(row);
}
