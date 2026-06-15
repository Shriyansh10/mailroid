import { z } from "zod";

// ── Thread list output ───────────────────────────────────────────────

export const threadSummaryOutputModel = z.object({
  threadId: z.string(),
  sender: z.string(),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
});

export const threadListOutputModel = z.object({
  threads: z.array(threadSummaryOutputModel),
  nextPageToken: z.string().nullable(),
});

// ── Thread detail output ─────────────────────────────────────────────

export const messageDetailOutputModel = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  date: z.string(),
  body: z.string(),
  htmlBody: z.string(),
  snippet: z.string(),
});

export const threadDetailOutputModel = z.object({
  threadId: z.string(),
  subject: z.string(),
  messages: z.array(messageDetailOutputModel),
});

// ── Send email output ────────────────────────────────────────────────

export const sendEmailOutputModel = z.object({
  id: z.string(),
  threadId: z.string(),
});
