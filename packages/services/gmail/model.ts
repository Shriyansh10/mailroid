import { z } from "zod";

// ── Thread summary (inbox row) ───────────────────────────────────────

export const threadSummarySchema = z.object({
  threadId: z.string(),
  sender: z.string(),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
});

export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadListResultSchema = z.object({
  threads: z.array(threadSummarySchema),
  nextPageToken: z.string().nullable(),
});

export type ThreadListResult = z.infer<typeof threadListResultSchema>;

// ── Message detail (inside a thread) ─────────────────────────────────

export const messageDetailSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  date: z.string(),
  body: z.string(),
  htmlBody: z.string(),
  snippet: z.string(),
});

export type MessageDetail = z.infer<typeof messageDetailSchema>;

// ── Thread detail (single thread view) ───────────────────────────────

export const threadDetailSchema = z.object({
  threadId: z.string(),
  subject: z.string(),
  messages: z.array(messageDetailSchema),
});

export type ThreadDetail = z.infer<typeof threadDetailSchema>;

// ── Send email input ─────────────────────────────────────────────────

export const sendEmailInputSchema = z.object({
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().optional(),
});

export type SendEmailInput = z.infer<typeof sendEmailInputSchema>;

// ── Send email output ────────────────────────────────────────────────

export const sendEmailResultSchema = z.object({
  id: z.string(),
  threadId: z.string(),
});

export type SendEmailResult = z.infer<typeof sendEmailResultSchema>;

// ── Stored email (local DB row) ─────────────────────────────────────

export const storedEmailSchema = z.object({
  id: z.string(),
  userId: z.string(),
  gmailMessageId: z.string(),
  threadId: z.string(),
  subject: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  snippet: z.string().nullable(),
  bodyText: z.string().nullable(),
  receivedAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
});

export type StoredEmail = z.infer<typeof storedEmailSchema>;

// ── Sync result ─────────────────────────────────────────────────────

export const syncResultSchema = z.object({
  synced: z.number(),
});

export type SyncResult = z.infer<typeof syncResultSchema>;

// ── Email count ─────────────────────────────────────────────────────

export const emailCountSchema = z.object({
  count: z.number(),
});

export type EmailCount = z.infer<typeof emailCountSchema>;
