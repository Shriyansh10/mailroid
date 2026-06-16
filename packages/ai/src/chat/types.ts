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

// ── Stream chunk ─────────────────────────────────────────────────────

export const ChatStreamChunkSchema = z.object({
  content: z.string(),
  done: z.boolean(),
});

export type ChatStreamChunk = z.infer<typeof ChatStreamChunkSchema>;
