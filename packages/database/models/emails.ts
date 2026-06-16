import { pgTable, uuid, text, timestamp, jsonb, customType } from "drizzle-orm/pg-core";

/**
 * Custom vector type for pgvector PostgreSQL extension.
 * Uses `customType` because drizzle-orm 0.45.x doesn't natively export
 * pgvector for PostgreSQL (only SingleStore).
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value);
  },
  fromDriver(value: unknown): number[] {
    if (typeof value === "string") return JSON.parse(value) as number[];
    if (Array.isArray(value)) return value as number[];
    return [];
  },
});

export const emails = pgTable("emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  gmailMessageId: text("gmail_message_id").notNull().unique(),
  threadId: text("thread_id").notNull(),
  subject: text("subject"),
  from: text("from"),
  to: text("to"),
  snippet: text("snippet"),
  bodyText: text("body_text"),
  rawPayload: jsonb("raw_payload"),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  embedding: vector("embedding"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
