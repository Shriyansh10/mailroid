import { z } from "zod";

// ── Chat message ─────────────────────────────────────────────────────

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ── Chat request ─────────────────────────────────────────────────────
//
// Deliberately just { conversationId?, message } — no messages[] array, and
// no system prompt. The client used to send the FULL conversation plus a
// self-built system prompt on every turn, and the server trusted it
// verbatim (a crafted POST could replace the SENDER IDENTITY rules). The
// server now loads history from the database and builds the system prompt
// itself; the client only ever contributes the one new user message.

export const ChatRequestSchema = z.object({
  conversationId: z.string().optional().nullable(),
  message: z.string().min(1),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// ── Chat response (non-streaming) ────────────────────────────────────

export const ChatResponseSchema = z.object({
  role: z.literal("assistant"),
  content: z.string(),
});

export type ChatResponse = z.infer<typeof ChatResponseSchema>;

// ── Approval required response ───────────────────────────────────────

export interface ApprovalRequiredResponse {
  role: "assistant";
  content: string;
  approvalRequired: {
    approvalId: string;
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    preview: string;
    /**
     * The DeepSeek assistant message's `reasoning_content` from the turn
     * that requested the tool call. Must be passed back verbatim on the
     * synthetic assistant message when resuming — DeepSeek thinking mode
     * rejects null/fabricated values.
     */
    reasoningContent: string | null;
  };
}

/** Union of all possible responses from the agent loop */
export type AgentResponse = ChatResponse | ApprovalRequiredResponse;

// ── Stream chunk ─────────────────────────────────────────────────────

export const ChatStreamChunkSchema = z.object({
  content: z.string(),
  done: z.boolean(),
});

export type ChatStreamChunk = z.infer<typeof ChatStreamChunkSchema>;
