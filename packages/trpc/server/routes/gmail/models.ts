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
  /** Up to 2 profile signals ({source, value}) the classifier says drove the priority verdict. */
  matchedSignals: z
    .array(z.object({ source: z.string(), value: z.string() }))
    .nullable()
    .optional(),
  isActionRequired: z.boolean().optional(),
  isReplyNeeded: z.boolean().optional(),
  isUnread: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  isImportant: z.boolean().optional(),
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
  /**
   * The Cc line the message carried. No `bcc` counterpart exists on purpose:
   * Gmail strips Bcc from delivered mail, so there is no header to read on a
   * received message — only a draft you wrote still has one.
   */
  cc: z.string().optional(),
  /** Reply-To, when set — the reply box seeds its To line from this over From. */
  replyTo: z.string().optional(),
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
  // The actionable shape extracted alongside the summary. Every field is
  // optional and schemaVersion says which shape they're in, so adding one
  // later doesn't break older stored rows.
  summaryData: z
    .object({
      schemaVersion: z.number(),
      decisions: z.array(z.string()).optional(),
      openQuestions: z.array(z.string()).optional(),
      actionItems: z
        .array(z.object({ text: z.string(), owner: z.string().optional(), due: z.string().optional() }))
        .optional(),
      deadlines: z.array(z.object({ what: z.string(), when: z.string() })).optional(),
      people: z.array(z.object({ name: z.string(), role: z.string().optional() })).optional(),
    })
    .nullable()
    .optional(),

  // Provenance — MUST stay in sync with threadDetailSchema in
  // packages/services/gmail/model.ts. This is a duplicated definition and
  // .output() strips undeclared keys, so omitting these here would silently
  // drop the staleness signal on the way to the browser: the UI would render
  // a cached thread as if it were live, with no error anywhere to notice.
  source: z.enum(["live", "cache"]).optional(),
  cachedAt: z.string().nullable().optional(),
  staleReason: z.enum(["rate-limited", "unavailable"]).optional(),
  retryAfter: z.string().nullable().optional(),
});

// ── Send email output ────────────────────────────────────────────────

export const sendEmailOutputModel = z.object({
  id: z.string(),
  threadId: z.string(),
});
