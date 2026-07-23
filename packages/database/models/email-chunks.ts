import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { vector } from "./emails.ts";

// Detail-recall index for a single email at a time — NOT a mailbox-wide
// search index (that's emails.embedding). Populated lazily by
// getEmailDetail's ensureEmailChunks (apps/web/lib/executors/email-detail.ts)
// the first time a follow-up question needs a passage the digest didn't
// carry, from summary_full_text (the guardrailed, uncompressed body) rather
// than the raw email — so a chunk can never contain anything that hasn't
// already passed PII masking / secret redaction / prompt-injection stripping.
//
// Deliberately decoupled from the summarize pipeline itself: chunks require
// only that summary_full_text exists, not that this specific request paid to
// generate it, so a later mailbox-wide backfill can populate them without
// re-summarizing every email.
export const emailChunks = pgTable(
  "email_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    // message_metadata.entity_id (a Gmail message id) — not enforced as an
    // FK because message_metadata rows can be deleted/resynced independently.
    entityId: text("entity_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_email_chunks_user_entity").on(table.userId, table.entityId),
  ],
);
