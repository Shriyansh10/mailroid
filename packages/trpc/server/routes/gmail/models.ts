import { z } from "zod";

// ── Thread list output ───────────────────────────────────────────────

export const threadSummaryOutputModel = z.object({
  threadId: z.string(),
  sender: z.string(),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
  priority: z.string().optional(),
  priorityScore: z.number().nullable().optional(),
  priorityReason: z.string().nullable().optional(),
  isActionRequired: z.boolean().optional(),
  isReplyNeeded: z.boolean().optional(),
  isUnread: z.boolean().optional(),
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
  priority: z.string().optional(),
  priorityScore: z.number().nullable().optional(),
  priorityReason: z.string().nullable().optional(),
  isActionRequired: z.boolean().optional(),
  // On-demand AI summary, present only once the user has paid an action for
  // it. summaryFlags reports what the guardrails masked or stripped.
  summary: z.string().nullable().optional(),
  summaryDigest: z.string().nullable().optional(),
  summaryFullText: z.string().nullable().optional(),
  summaryFlags: z
    .object({
      injectionBlocked: z.boolean(),
      maskedCategories: z.array(z.string()),
      secretsRedacted: z.boolean(),
    })
    .nullable()
    .optional(),
});

// ── Send email output ────────────────────────────────────────────────

export const sendEmailOutputModel = z.object({
  id: z.string(),
  threadId: z.string(),
});
