import { z } from "zod";

// ── Thread summary (inbox row) ───────────────────────────────────────

export const threadSummarySchema = z.object({
  threadId: z.string(),
  /** The Gmail message id of the message this row represents — resolvable via message_metadata/emails. Absent for results the live Gmail API path doesn't attach a local id to. */
  entityId: z.string().optional(),
  sender: z.string(),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
  /** Cosine similarity (1 - distance), 0-1 higher is better. Only set by vector search. */
  score: z.number().optional(),
  priority: z.string().optional(),
  priorityScore: z.number().nullable().optional(),
  priorityReason: z.string().nullable().optional(),
  isActionRequired: z.boolean().optional(),
  isReplyNeeded: z.boolean().optional(),
  isUnread: z.boolean().optional(),
  /** Gmail-style category (PRIMARY/UPDATES/PROMOTIONS/SPAM/…), enriched from message_metadata for display bucketing. */
  category: z.string().optional(),
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
  priority: z.string().optional(),
  priorityScore: z.number().nullable().optional(),
  priorityReason: z.string().nullable().optional(),
  isActionRequired: z.boolean().optional(),
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

// ── Reply / forward input ────────────────────────────────────────────
//
// entityId, not threadId: the RECIPIENT and RFC threading headers (Message-
// ID, References) are derived from one specific original message, which a
// thread id alone doesn't identify. Deliberately no `to`/`subject` here for
// replyToEmail — those come from the original message, never the model, so
// a masked-PII sender ([EMAIL] in anything the model has seen) can't become
// a wrong or fabricated recipient. See packages/services/gmail/index.ts.

export const replyToEmailInputSchema = z.object({
  entityId: z.string(),
  body: z.string(),
  replyAll: z.boolean().optional(),
});

export type ReplyToEmailInput = z.infer<typeof replyToEmailInputSchema>;

export const forwardEmailInputSchema = z.object({
  entityId: z.string(),
  to: z.string(),
  note: z.string().optional(),
});

export type ForwardEmailInput = z.infer<typeof forwardEmailInputSchema>;

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

// ── Local search result (from emails table) ──────────────────────────

export const localSearchResultSchema = z.object({
  threads: z.array(threadSummarySchema),
  total: z.number(),
  /** Count of PROMOTIONS/SPAM/TRASH rows hidden from `threads` (disclosed to the user). */
  spamCount: z.number().optional(),
  /** Emails withheld because their sender is on the user's protected blocklist. */
  hiddenProtected: z
    .object({ count: z.number(), senders: z.array(z.string()) })
    .optional(),
});

export type LocalSearchResult = z.infer<typeof localSearchResultSchema>;

// ── Search-result display bucketing ──────────────────────────────────
//
// A fetch can return 100 mixed rows from one sender (Myntra: orders + promos +
// spam). We show only the "primary" bucket, cap it, and hide-and-count the
// junk so the assistant can disclose "N are promotions/spam". Pure + no DB, so
// it's unit-testable in isolation.

const ALWAYS_HIDDEN = new Set(["SPAM", "TRASH"]);

export function partitionSearchResults(
  threads: ThreadSummary[],
  opts: { topicGiven: boolean; includePromotions: boolean; primaryCap: number },
): { primary: ThreadSummary[]; primaryTotal: number; spamCount: number } {
  // Promotions are junk only for an untargeted listing. When the user searched
  // a topic (or asked to see promotions), keep them in the ranked results.
  const hidePromotions = !opts.topicGiven && !opts.includePromotions;

  const primary: ThreadSummary[] = [];
  let spamCount = 0;
  for (const t of threads) {
    const cat = (t.category ?? "").toUpperCase();
    const isJunk = ALWAYS_HIDDEN.has(cat) || (hidePromotions && cat === "PROMOTIONS");
    if (isJunk) {
      spamCount++;
      continue;
    }
    primary.push(t);
  }

  return {
    primary: primary.slice(0, opts.primaryCap),
    primaryTotal: primary.length,
    spamCount,
  };
}

// ── Embeddings ───────────────────────────────────────────────────────

export const embedResultSchema = z.object({
  embedded: z.number(),
});

export type EmbedResult = z.infer<typeof embedResultSchema>;

export const pendingEmbeddingsCountSchema = z.object({
  pending: z.number(),
});

export type PendingEmbeddingsCount = z.infer<typeof pendingEmbeddingsCountSchema>;
