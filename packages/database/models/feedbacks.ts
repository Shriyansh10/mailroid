import { pgTable, text, timestamp, uuid, real, boolean, index } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

export const feedbacks = pgTable("feedbacks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  feedbackText: text("feedback_text").notNull(),
  normalizedText: text("normalized_text").notNull(),
  score: real("score").notNull(),
  category: text("category").notNull(), // bug, feature_request, ux, performance, calendar, gmail, assistant, other
  approved: boolean("approved").notNull(),
  requiresReview: boolean("requires_review").notNull().default(false),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_feedbacks_user_id").on(table.userId),
]);
