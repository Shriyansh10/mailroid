import { z } from "zod";

// ── Thread list output ───────────────────────────────────────────────

export const threadSummaryOutputModel = z.object({
  threadId: z.string(),
  /** Gmail message id for this row — needed by row-level actions. */
  entityId: z.string().optional(),
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
  isStarred: z.boolean().optional(),
  /** PRIMARY/PROMOTIONS/SPAM/TRASH/DRAFT/… — lets rows render view-specific actions. */
  category: z.string().optional(),
  /** Gmail draft resource id; DRAFT rows only. Required to reopen or send the draft. */
  draftId: z.string().optional(),
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
  /** True when this message is an unsent draft (Gmail groups drafts into their reply thread by threadId). */
  isDraft: z.boolean().optional(),
  /** Gmail draft resource id, present only when isDraft is true — needed to edit/send it. */
  draftId: z.string().optional(),
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
