import { z } from "zod";

// ── Attachment (shared by the inbox row and the thread view) ─────────

/**
 * One attachment. Metadata only — bytes are fetched separately, per request,
 * through an authorized route.
 *
 * Declared before threadSummarySchema because both schemas reference it and a
 * zod object is evaluated at module load: defined lower down, the first
 * reference would hit the temporal dead zone and throw on import.
 */
export const messageAttachmentSchema = z.object({
  /**
   * Our own `message_attachments.id`, and the only attachment identifier the
   * browser ever sees. Null when the manifest has been parsed live but not yet
   * persisted, in which case the chip renders without a download action rather
   * than inventing a URL that would 404.
   */
  id: z.string().nullable(),
  partId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  /**
   * The bytes are already in object storage. Metadata, never a download: it
   * lets the UI render an image thumbnail only when that costs no Gmail call.
   * Absent or false → show a placeholder with "Load preview".
   */
  cached: z.boolean().optional(),
});

export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

/**
 * One inline image, for resolving a `cid:` reference in an HTML body.
 *
 * A SEPARATE FIELD FROM `attachments`, deliberately, and the separation is the
 * control rather than a convention. Inline parts are filtered out of the chip
 * list at every producing site because a signature logo is body furniture, not
 * a document — putting them back into that array so the renderer could reach
 * them would restore the chips too, in several places at once, and only one of
 * those would have to be missed for the regression to ship.
 *
 * Carries the two fields resolution needs and nothing else. Entries are emitted
 * only when BOTH are known, so the renderer never has to reason about a
 * half-resolvable image: an unpersisted manifest yields no entries and the
 * `cid:` stays unresolved, exactly as it is today.
 */
export const inlineImageSchema = z.object({
  /** `Content-ID`, angle brackets already stripped by parse.ts. */
  contentId: z.string(),
  /** Our `message_attachments.id` — what `/api/attachments/{id}` needs. */
  id: z.string(),
});

export type InlineImage = z.infer<typeof inlineImageSchema>;

// ── Thread summary (inbox row) ───────────────────────────────────────

export const threadSummarySchema = z.object({
  threadId: z.string(),
  /** The Gmail message id of the message this row represents — resolvable via message_metadata/emails. Absent for results the live Gmail API path doesn't attach a local id to. */
  entityId: z.string().optional(),
  sender: z.string(),
  /** The `To` header of the message this row represents. Only meaningful in
      the Sent and Draft views, where every row is from the user and the sender
      says nothing — those views show this instead. */
  recipient: z.string().optional(),
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
  isImportant: z.boolean().optional(),
  /** Gmail-style category (PRIMARY/UPDATES/PROMOTIONS/SPAM/…), enriched from message_metadata for display bucketing. */
  category: z.string().optional(),
  /** Gmail draft resource id — present only on DRAFT rows, needed to reopen/send the draft. */
  draftId: z.string().optional(),
  /**
   * Attachment chips for the inbox row, from the persisted manifest.
   *
   * Unlike messageDetailSchema.attachments, absence here carries NO meaning:
   * the list path never reads a payload, so an un-hydrated thread simply has
   * nothing to show. The row makes no claim either way — see
   * listAttachmentsForThreads.
   */
  attachments: z.array(messageAttachmentSchema).optional(),
  /**
   * "Something is attached here", for rows with no manifest yet.
   *
   * Three states, and only `true` renders: null means nothing has looked, and
   * false means we looked and there is nothing. A row that has real chips
   * ignores this — chips are strictly better information.
   */
  hasAttachment: z.boolean().nullable().optional(),
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
  /**
   * The message's attachments — and the absence of this field is meaningful.
   *
   *   an array (even empty) → authoritative. We read the full payload, or we
   *                           hold a persisted manifest. `[]` means none.
   *   null / absent         → UNKNOWN. The message was synced metadata-only, so
   *                           there is no payload to parse and no manifest to
   *                           read. It may well have attachments.
   *
   * The UI must render those two states differently. Collapsing "unknown" into
   * "none" would tell a user their mail has no attachments when we simply never
   * looked, which is the silent degradation this codebase keeps ruling out.
   */
  attachments: z.array(messageAttachmentSchema).nullable().optional(),
  /**
   * Inline images this message's HTML body can reference by `cid:`.
   *
   * Unlike `attachments`, absence here means nothing at all — an empty list and
   * a missing field both mean "no `cid:` reference can be resolved", and the
   * renderer treats them identically. There is no "unknown" state worth
   * distinguishing, because the only consequence is whether an image renders.
   */
  inlineImages: z.array(inlineImageSchema).optional(),
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
  /**
   * Forward WITHOUT the original's files. Only ever set by an explicit choice —
   * the "Forward without attachments" action after a carry failure, or the
   * user telling Dobbie so. Absent means the files go, or nothing does.
   */
  omitOriginalAttachments: z.boolean().optional(),
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
