import { ToolExecutionStatus, type ToolResult } from "@repo/ai";

/**
 * Active-email ledger entry, written onto a tool message's `metadata` column
 * when summarizeEmail resolves an email successfully. The active email for a
 * conversation is simply "the newest assistant_messages row whose metadata
 * contains emailRef" — no separate table, no migration, and it naturally
 * follows the user switching emails mid-chat (newest write wins).
 */
export interface EmailRef {
  entityId: string;
  threadId?: string;
  subject?: string;
  sender?: string;
  receivedAt?: string;
}

/**
 * Derives the metadata to persist alongside a tool result, keyed by tool
 * name. Kept in apps/web (not @repo/ai) because it knows about this specific
 * tool's output shape — @repo/ai's agent loop stays tool-agnostic and just
 * calls this as an injected hook.
 *
 * Deliberately does NOT write emailRef when the lookup failed (found:false)
 * — a failed lookup must not clear the conversation's active email.
 */
export function deriveToolMessageMetadata(
  toolName: string,
  _args: Record<string, unknown>,
  result: ToolResult,
): Record<string, unknown> | undefined {
  if (toolName !== "summarizeEmail") return undefined;
  if (result.status !== ToolExecutionStatus.SUCCESS) return undefined;

  const data = result.data as
    | { found?: boolean; entityId?: string; threadId?: string; subject?: string; sender?: string; receivedAt?: string }
    | undefined;

  if (!data?.found || !data.entityId) return undefined;

  const emailRef: EmailRef = {
    entityId: data.entityId,
    threadId: data.threadId,
    subject: data.subject,
    sender: data.sender,
    receivedAt: data.receivedAt,
  };

  // toolName travels with the ref so history trimming can rebuild a
  // correctly-tagged <tool_result tool="..."> stub without guessing.
  return { emailRef, toolName };
}
