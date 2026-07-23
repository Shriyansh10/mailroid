import { db, eq, and, asc, sql } from "@repo/database";
import { assistantMessages } from "@repo/database/schema";
import { messageMetadata } from "@repo/database/models/message-metadata";
import type { EmailContext } from "./system-prompt";
import type { EmailRef } from "./tool-memory";

export interface DbChatMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  metadata?: Record<string, unknown> | null;
}

/** Loads the full, ordered conversation history from the database. */
export async function loadConversationHistory(
  conversationId: string,
): Promise<DbChatMessage[]> {
  const rows = await db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(asc(assistantMessages.createdAt));

  return rows.map((r) => ({
    role: r.role as "user" | "assistant" | "tool",
    content: r.content,
    tool_calls: r.toolCalls ?? undefined,
    tool_call_id: r.toolCallId ?? undefined,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  }));
}

/**
 * Resolves the conversation's active email: the newest tool message whose
 * metadata carries an emailRef. Re-reads subject/sender/receivedAt from
 * message_metadata by (entityId, userId) rather than trusting the cached
 * values in metadata — a cheap PK lookup that stays fresh and re-verifies
 * the email still belongs to this user.
 *
 * Returns undefined if no email has been discussed yet, or if the
 * previously-referenced email no longer resolves for this user (deleted
 * locally, ownership mismatch, etc.) — a stale reference must not be handed
 * to the model as fact.
 */
export async function getActiveEmailContext(
  conversationId: string,
  userId: string,
): Promise<EmailContext | undefined> {
  const rows = await db
    .select({ metadata: assistantMessages.metadata })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.conversationId, conversationId),
        sql`${assistantMessages.metadata} -> 'emailRef' IS NOT NULL`,
      ),
    )
    .orderBy(sql`${assistantMessages.createdAt} DESC`)
    .limit(1);

  const ref = (rows[0]?.metadata as { emailRef?: EmailRef } | undefined)?.emailRef;
  if (!ref?.entityId) return undefined;

  const [meta] = await db
    .select({
      entityId: messageMetadata.entityId,
      threadId: messageMetadata.threadId,
      subject: messageMetadata.subject,
      sender: messageMetadata.sender,
      receivedAt: messageMetadata.receivedAt,
    })
    .from(messageMetadata)
    .where(and(eq(messageMetadata.entityId, ref.entityId), eq(messageMetadata.userId, userId)))
    .limit(1);

  if (!meta) return undefined;

  return {
    entityId: meta.entityId,
    threadId: meta.threadId ?? undefined,
    subject: meta.subject ?? undefined,
    sender: meta.sender ?? undefined,
    receivedAt: meta.receivedAt?.toISOString(),
  };
}

// ── Trimming ─────────────────────────────────────────────────────────
//
// Applied only to the copy sent to the model — DB rows are never modified,
// so the UI transcript always shows everything. Exists because summarizeEmail
// tool results (the digest) are the single largest thing in this
// conversation's history, and resending every one of them on every turn is
// what previously blew the context window (and caused the reported 500s).

const RECENT_TOOL_KEEP = 2;
const TRUNCATE_CHARS = 600;
const MAX_BUDGET_CHARS = 60_000;

interface Turn {
  messages: DbChatMessage[];
}

/**
 * Splits history into turns: a user message plus everything up to (not
 * including) the next user message. A turn is the atomic unit for budget
 * dropping — dropping a whole turn can never orphan an assistant tool_calls
 * message from its tool response, which is what would make healConversation
 * (packages/ai/src/chat/agent.ts) paper over it with a phantom "cancelled".
 */
function splitIntoTurns(messages: DbChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: DbChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (current.length > 0) turns.push({ messages: current });
      current = [m];
    } else {
      current.push(m);
    }
  }
  if (current.length > 0) turns.push({ messages: current });
  return turns;
}

/**
 * Trims conversation history for the model's context, independent of the
 * per-turn EMAIL CONTEXT injection:
 *   1. The newest RECENT_TOOL_KEEP tool results stay verbatim.
 *   2. Older tool results that carry an emailRef collapse to a small stub —
 *      the model still knows an email was discussed and which one, but the
 *      full digest isn't resent; getEmailDetail (Phase 4) covers follow-ups.
 *   3. Other older tool results are truncated to TRUNCATE_CHARS.
 *   4. Oldest whole turns are dropped once the total exceeds MAX_BUDGET_CHARS
 *      — never the most recent turn, so the current exchange is never cut.
 */
export function trimHistoryForModel(messages: DbChatMessage[]): DbChatMessage[] {
  const toolIndices = messages
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const recentToolIndices = new Set(toolIndices.slice(-RECENT_TOOL_KEEP));

  const trimmed = messages.map((m, i) => {
    if (m.role !== "tool" || recentToolIndices.has(i)) return m;

    const meta = m.metadata as { emailRef?: EmailRef; toolName?: string } | null;
    if (meta?.emailRef) {
      const stub = {
        entityId: meta.emailRef.entityId,
        subject: meta.emailRef.subject,
        sender: meta.emailRef.sender,
        note: "digest elided — call getEmailDetail for specifics",
      };
      return {
        ...m,
        content: `<tool_result tool="${meta.toolName ?? "summarizeEmail"}">\n${JSON.stringify(stub)}\n</tool_result>`,
      };
    }

    const content = m.content ?? "";
    if (content.length <= TRUNCATE_CHARS) return m;
    return { ...m, content: content.slice(0, TRUNCATE_CHARS) + "\n…[truncated]" };
  });

  const turns = splitIntoTurns(trimmed);
  const turnChars = turns.map((t) =>
    t.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
  );

  let totalChars = turnChars.reduce((a, b) => a + b, 0);
  let startIdx = 0;
  while (startIdx < turns.length - 1 && totalChars > MAX_BUDGET_CHARS) {
    totalChars -= turnChars[startIdx]!;
    startIdx++;
  }

  return turns.slice(startIdx).flatMap((t) => t.messages);
}
