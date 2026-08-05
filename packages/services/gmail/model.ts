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
  /** Up to 2 profile signals ({source, value}) the classifier says drove the priority verdict — see formatMatchedSignal for how these render. */
  matchedSignals: z
    .array(z.object({ source: z.string(), value: z.string() }))
    .nullable()
    .optional(),
  isActionRequired: z.boolean().optional(),
  isReplyNeeded: z.boolean().optional(),
  isUnread: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  /** Gmail-style category (PRIMARY/UPDATES/PROMOTIONS/SPAM/…), enriched from message_metadata for display bucketing. */
  category: z.string().optional(),
  /** Gmail draft resource id — present only on DRAFT rows, needed to reopen/send the draft. */
  draftId: z.string().optional(),
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
  /**
   * The message's Cc line, when it had one.
   *
   * There is deliberately no `bcc` here: Gmail strips Bcc from every delivered
   * copy, so a received message has no Bcc header to read and the field would
   * be permanently empty — which reads as a bug rather than as the privacy
   * guarantee it actually is. Bcc survives only on a draft you wrote yourself,
   * which is why getDraft returns it and this doesn't.
   */
  cc: z.string().optional(),
  /** The message's Reply-To, when it set one — where a reply actually belongs. */
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
  // Extracted alongside the summary, in the same model call. Every field
  // optional and shape-versioned so a later addition doesn't invalidate
  // rows written today.
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

  // Provenance. When Gmail is unreachable (rate limit, 5xx, transport) the
  // thread is served from the local copy instead of failing — but the caller
  // and ultimately the user are told, never silently handed stale content.
  //
  // NOTE: threadDetailOutputModel in packages/trpc/server/routes/gmail/models.ts
  // is a SEPARATE, duplicated definition, and tRPC's .output() strips keys it
  // doesn't declare. These four fields must exist in both or staleness vanishes
  // between the service and the browser with nothing raised anywhere.
  source: z.enum(["live", "cache"]).optional(),
  cachedAt: z.string().nullable().optional(),
  staleReason: z.enum(["rate-limited", "unavailable"]).optional(),
  retryAfter: z.string().nullable().optional(),
});

export type ThreadDetail = z.infer<typeof threadDetailSchema>;

// ── Send email input ─────────────────────────────────────────────────

export const sendEmailInputSchema = z.object({
  to: z.string(),
  /** Comma-separated, same shape as the RFC header this ends up as. */
  cc: z.string().optional(),
  bcc: z.string().optional(),
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
// thread id alone doesn't identify. There is still no `subject` for
// replyToEmail — that always comes from the original message.
//
// `to`/`cc`/`bcc` are optional overrides, and who may pass them is the whole
// point of them being optional. The assistant cannot: they are absent from the
// replyToEmail tool schema (packages/ai/src/tools/registry.ts), so a model call
// physically has nowhere to put a recipient — which matters because a masked-
// PII sender ([EMAIL] in anything the model has seen) could otherwise become a
// wrong or fabricated one. The inline reply box is the one caller that does
// pass them: a human editing the To/Cc/Bcc lines the way Gmail allows.
// Omitted means "derive it", not "leave it empty". See
// packages/services/gmail/index.ts.

export const replyToEmailInputSchema = z.object({
  entityId: z.string(),
  body: z.string(),
  replyAll: z.boolean().optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
});

export type ReplyToEmailInput = z.infer<typeof replyToEmailInputSchema>;

export const forwardEmailInputSchema = z.object({
  entityId: z.string(),
  to: z.string(),
  // Human-only, same as replyToEmail's overrides: the forwardEmail tool schema
  // exposes `to` and `note` and nothing else.
  cc: z.string().optional(),
  bcc: z.string().optional(),
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
