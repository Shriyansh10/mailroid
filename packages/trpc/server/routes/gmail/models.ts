import { z } from "zod";

/**
 * MUST stay in sync with messageAttachmentSchema in
 * packages/services/gmail/model.ts.
 *
 * Declared first because both output models below reference it — see the note
 * on the services copy about module-load ordering.
 */
export const messageAttachmentOutputModel = z.object({
  /** Our own attachment id — null when parsed live but not yet persisted. */
  id: z.string().nullable(),
  partId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  /** Bytes already in object storage — a thumbnail would cost no Gmail call. */
  cached: z.boolean().optional(),
});

/**
 * MUST stay in sync with inlineImageSchema in
 * packages/services/gmail/model.ts.
 *
 * Separate from the attachment model on purpose — see the note there on why
 * inline parts must not rejoin the chip list.
 */
export const inlineImageOutputModel = z.object({
  contentId: z.string(),
  id: z.string(),
});

// ── Thread list output ───────────────────────────────────────────────

export const threadSummaryOutputModel = z.object({
  threadId: z.string(),
  /** Gmail message id for this row — needed by row-level actions. */
  entityId: z.string().optional(),
  sender: z.string(),
  /** The `To` header of the message this row represents. Only meaningful in
      the Sent and Draft views, where every row is from the user and the sender
      says nothing — those views show this instead. */
  recipient: z.string().optional(),
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
  /**
   * Attachment chips for the row. Absence carries no meaning here — the list
   * path never parses a payload, so an un-hydrated thread simply has none to
   * show and the row claims nothing either way.
   */
  attachments: z.array(messageAttachmentOutputModel).optional(),
  /** Paperclip indicator for rows with no manifest yet. Only `true` renders. */
  hasAttachment: z.boolean().nullable().optional(),
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
  /**
   * Attachments, where null/absent means UNKNOWN rather than none — see the
   * long note on messageDetailSchema in packages/services/gmail/model.ts.
   * Omitting this field here would make `.output()` strip it silently and the
   * chips would never render, with nothing failing to say why.
   */
  attachments: z.array(messageAttachmentOutputModel).nullable().optional(),
  /**
   * Inline images addressable by `cid:` from htmlBody. Same reason this is
   * declared at all: an omitted field is stripped by `.output()` without
   * error, and the symptom would be every inline image silently staying broken
   * with nothing anywhere reporting a failure.
   */
  inlineImages: z.array(inlineImageOutputModel).optional(),
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
