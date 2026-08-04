import {
  pgTable,
  text,
  jsonb,
  timestamp,
  boolean,
  real,
  integer,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

// ── Enums ─────────────────────────────────────────────────────────────

export const mailCategoryEnum = pgEnum("mail_category", [
  "PRIMARY",
  "PROMOTIONS",
  "SOCIAL",
  "UPDATES",
  "FORUMS",
  "SENT",
  "SPAM",
  "TRASH",
  // Gmail keeps drafts as a separate resource, but they carry the DRAFT label
  // and we mirror them into the same table so the Draft view is served from
  // local DB like every other view. STARRED is deliberately NOT a category —
  // a message is starred *and* still lives in its real category, so that state
  // belongs on the isStarred boolean below.
  "DRAFT",
  "OTHER",
]);

export const priorityEnum = pgEnum("priority_level", [
  "HIGH",
  "MEDIUM",
  "LOW",
]);

// ── Metadata table ─────────────────────────────────────────────────────

export const messageMetadata = pgTable(
  "message_metadata",
  {
    entityId: text("entity_id").primaryKey(),

    userId: text("user_id").notNull(),

    gmailLabels: jsonb("gmail_labels").notNull().default([]),

    category: mailCategoryEnum("category").default("OTHER"),

    receivedAt: timestamp("received_at", { withTimezone: true }),
    threadId: text("thread_id"),

    // The RFC822 `Message-ID` header, normalised (angle brackets stripped).
    //
    // Unlike `entityId` and `threadId` — which Gmail assigns per mailbox, so
    // the organiser and a guest hold *different* ids for the same
    // conversation — this header travels with the message itself and is
    // identical in every copy. It is therefore the only thing that can join
    // one person's thread to another's, which is what makes a meeting
    // scheduled from a thread visible to the guest who was invited.
    //
    // Three distinct states, and they must stay distinguishable:
    //   NULL  — never looked. This is the backfill's cursor.
    //   ''    — looked, and there is nothing to store (the message carries no
    //           Message-ID, or Gmail no longer has it). Stops the backfill
    //           re-fetching the same dead rows on every run.
    //   value — the normalised header.
    // Readers must treat '' exactly like NULL; only the backfill distinguishes
    // them. Do not add a default: it would erase the cursor.
    rfc822MessageId: text("rfc822_message_id"),

    isUnread: boolean("is_unread").notNull().default(true),
    isInInbox: boolean("is_in_inbox").notNull().default(false),
    isStarred: boolean("is_starred").notNull().default(false),
    isImportant: boolean("is_important").notNull().default(false),

    // Set when Gmail permanently removes a message — chiefly its ~30-day Trash
    // purge, observed via `messagesDeleted` in the history diff. We deliberately
    // do NOT delete the row: the user stops seeing it (Bin filters on this) but
    // the content is retained. Nothing else ever sets this, so an archived row
    // always means "gone from Gmail, kept by us".
    isArchived: boolean("is_archived").notNull().default(false),

    // Gmail's draft resource id, which is NOT the message id. Required to call
    // drafts.update / drafts.send on an existing draft, so it must be stored
    // rather than derived. NULL for everything that isn't a draft.
    draftId: text("draft_id"),

    // No default. An email is unclassified (priority IS NULL) until the LLM
    // actually classifies it — a MEDIUM default lied about that (every synced
    // row read as classified with a NULL score, which is self-contradictory).
    priority: priorityEnum("priority"),
    priorityScore: real("priority_score"),
    priorityReason: text("priority_reason"),
    // Which profile signals drove the classification, as structured
    // { source, value } pairs (e.g. {source:"goal",value:"job_search"}).
    // NULL for emails classified before personalization existed.
    matchedSignals: jsonb("matched_signals").$type<
      { source: string; value: string }[]
    >(),

    sender: text("sender"),
subject: text("subject"),
snippet: text("snippet"),

    isActionRequired: boolean("is_action_required").notNull().default(false),
    isReplyNeeded: boolean("is_reply_needed").notNull().default(false),

    // On-demand, user-initiated one-line summary ("Summarize this mail",
    // costs one daily action). Cached here so re-opening a thread never
    // charges a second time. NULL = never summarized, which is the normal
    // state — this is deliberately not generated during bulk classification.
    // summaryFlags records what the guardrails did (PII masked, injection
    // stripped) so the UI can disclose it; it never holds the values.
    // Two products from one generation: `summary` is the few-sentence
    // overview for the card, `summaryDigest` the full structured rewrite
    // shown on open and used as the assistant's retrieval context in place
    // of the raw email (smaller, de-boilerplated, already scrubbed).
    summary: text("summary"),
    summaryDigest: text("summary_digest"),
    // Guardrailed-but-uncompressed body: PII masked, secrets redacted,
    // injection stripped, but not rewritten into digest form. The digest
    // aims to preserve every fact, but summarization can still drop a detail
    // (e.g. a named entity mentioned once). This is the fallback the
    // assistant reaches for when a follow-up question needs something the
    // digest omitted — never the raw body itself.
    summaryFullText: text("summary_full_text"),
    summaryFlags: jsonb("summary_flags").$type<{
      injectionBlocked: boolean;
      maskedCategories: string[];
      secretsRedacted: boolean;
    }>(),
    // The actionable shape of the email, extracted in the same model call
    // that writes `summary` (no extra AI call). Every key is optional and
    // schemaVersion says which shape they are in, so adding a field later
    // (risks, sentiment, meeting requests) is not a migration.
    //
    // schemaVersion answers "what shape is this?"; summaryMeta.promptVersion
    // below answers "which prompt wrote it?" — a reader needs the first to
    // parse at all, so it lives inside the blob it describes.
    summaryData: jsonb("summary_data").$type<{
      schemaVersion: number;
      decisions?: string[];
      openQuestions?: string[];
      actionItems?: { text: string; owner?: string; due?: string }[];
      deadlines?: { what: string; when: string }[];
      people?: { name: string; role?: string }[];
    }>(),
    // What the document analyzer concluded — kept for tuning the pipeline
    // against real mail rather than guesses. promptVersion records which
    // generation of the summarize prompts produced the row; it is written
    // unconditionally but deliberately never acted on automatically, since
    // silently regenerating stale summaries would spend the user's daily
    // actions on mail they never asked about.
    summaryMeta: jsonb("summary_meta").$type<{
      type: string;
      topicCount: number;
      complexity: string;
      sections: number;
      promptVersion?: number;
    }>(),
    summaryGeneratedAt: timestamp("summary_generated_at", { withTimezone: true }),

    // The checkpoint for historical bulk classification: PENDING -> DONE or
    // FAILED. No PROCESSING state — classification concurrency is 1, so
    // there are no competing workers to guard against, and PROCESSING would
    // strand rows forever if a batch crashed mid-run. classificationAttempts
    // is what guarantees every email eventually leaves the PENDING pool, even
    // ones that can never classify (e.g. no sender/subject/snippet) — without
    // it those would be re-selected by every batch forever.
    classificationStatus: text("classification_status").notNull().default("PENDING"),
    classificationAttempts: integer("classification_attempts").notNull().default(0),

    // Mirrors classificationStatus/classificationAttempts above, but for the separate
    // hydration pipeline (fetching the full body into `emails.bodyText` so it can be
    // embedded). PENDING -> HYDRATING (claimed by a batch, before the Gmail fetch) ->
    // DONE or FAILED. HYDRATING (not just PENDING/DONE) exists so a worker/container
    // crash mid-fetch leaves a row distinguishable from "never picked up" — the
    // reconciliation cron resets stale HYDRATING rows back to PENDING. FAILED means
    // Gmail confirmed the message is permanently gone (404/410) and is never retried by
    // the normal batch loop; it is NOT a dead end — a future retry/backfill action can
    // reset FAILED -> PENDING (same shape as retryFailedClassifications).
    hydrationStatus: text("hydration_status").notNull().default("PENDING"),
    hydrationAttempts: integer("hydration_attempts").notNull().default(0),

    lastClassifiedAt: timestamp("last_classified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_mm_category").on(table.category),
    index("idx_mm_priority").on(table.priority),
    index("idx_mm_is_unread").on(table.isUnread),
    index("idx_mm_inbox_triage").on(
      table.isUnread,
      table.priority,
      table.isInInbox,
    ),
    index("idx_mm_user_category").on(table.userId, table.category),
    // Supports the Bin/Spam/Draft views, which all filter
    // WHERE user_id = ? AND category = ? AND is_archived = false.
    index("idx_mm_user_category_archived").on(
      table.userId,
      table.category,
      table.isArchived,
    ),
    // Supports the Starred view, which filters on the flag rather than category.
    index("idx_mm_user_starred").on(table.userId, table.isStarred),
    index("idx_mm_user_received").on(table.userId, table.receivedAt),
    // Supports the summarize resolver's entityId->threadId fallback (a model
    // sometimes hands back a thread id where a message id was expected) and
    // searchEmails' thread->newest-message-id lookup.
    index("idx_mm_user_thread").on(table.userId, table.threadId),
    // Serves both the guest-side thread→Message-ID lookup and the backfill's
    // `WHERE user_id = ? AND rfc822_message_id IS NULL` cursor.
    index("idx_mm_user_rfc822").on(table.userId, table.rfc822MessageId),
    // Supports the historical classification batch query: WHERE user_id = ?
    // AND classification_status = 'PENDING' ORDER BY received_at DESC.
    index("idx_mm_user_class_status_received").on(
      table.userId,
      table.classificationStatus,
      table.receivedAt,
    ),
    // Same shape, for the hydration batch query: WHERE user_id = ? AND
    // hydration_status = 'PENDING' ORDER BY received_at DESC.
    index("idx_mm_user_hydration_status_received").on(
      table.userId,
      table.hydrationStatus,
      table.receivedAt,
    ),
    // Supports the cheap per-user inbox change token: max(updated_at) filtered
    // by user_id, polled every ~10s by the client for realtime freshness.
    index("idx_mm_user_updated").on(table.userId, table.updatedAt),
  ],
);
