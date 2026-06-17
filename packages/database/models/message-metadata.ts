import {
  pgTable,
  text,
  jsonb,
  timestamp,
  boolean,
  real,
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

    isUnread: boolean("is_unread").notNull().default(true),
    isInInbox: boolean("is_in_inbox").notNull().default(false),
    isStarred: boolean("is_starred").notNull().default(false),
    isImportant: boolean("is_important").notNull().default(false),

    priority: priorityEnum("priority").default("MEDIUM"),
    priorityScore: real("priority_score"),
    priorityReason: text("priority_reason"),

    sender: text("sender"),
subject: text("subject"),
snippet: text("snippet"),

    isActionRequired: boolean("is_action_required").notNull().default(false),
    isReplyNeeded: boolean("is_reply_needed").notNull().default(false),

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
    index("idx_mm_user_received").on(table.userId, table.receivedAt),
  ],
);
