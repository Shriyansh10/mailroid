import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per user, written exactly once: the moment a user's first-ever
 * classify job (last_week/last_month) has classified, hydrated, AND indexed
 * its whole window. `completedAt` is a write-once latch, not a live status —
 * once set it is NEVER cleared or recomputed, and ordinary webhook mail
 * arriving later (briefly un-hydrated/un-indexed, by nature) must never
 * cause it to be unset. This is what lets Dobbie/semantic search gate on
 * "has this user ever finished initial setup" instead of "is everything
 * drained right now", which would flicker disabled on every new email.
 *
 * See @repo/services/gmail/classification.ts (getAiReadiness / maybe
 * completing the latch) for where this is read and written.
 */
export const aiSetupStatus = pgTable("ai_setup_status", {
  userId: text("user_id").primaryKey(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
