import { z } from "zod";

// ── Chat message ─────────────────────────────────────────────────────

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ── Chat request ─────────────────────────────────────────────────────

export const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
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
