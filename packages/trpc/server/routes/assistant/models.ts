import { z } from "zod";

export const conversationModel = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  lastMessagePreview: z.string().nullable(),
  deletedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const listConversationsOutputModel = z.array(conversationModel);

export const approvalRequiredModel = z.object({
  approvalId: z.string(),
  toolName: z.string(),
  toolCallId: z.string(),
  args: z.record(z.string(), z.any()),
  preview: z.string(),
  reasoningContent: z.string().nullable(),
  status: z.string().optional(),
});

export const assistantMessageModel = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().nullable(),
  toolCalls: z.any().nullable(),
  toolCallId: z.string().nullable(),
  createdAt: z.date(),
  approvalRequired: approvalRequiredModel.optional(),
  // App-specific per-message data, e.g. { emailRef } — see
  // apps/web/lib/assistant/tool-memory.ts. Opaque here; the client interprets it.
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const getMessagesOutputModel = z.array(assistantMessageModel);

export const deleteConversationOutputModel = z.object({
  success: z.boolean(),
});
