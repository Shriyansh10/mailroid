import { pgTable, text, timestamp, integer, boolean, primaryKey } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

export const userUsage = pgTable("user_usage", {
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // YYYY-MM-DD
  actionCount: integer("action_count").notNull().default(0),
  unlocked: boolean("unlocked").notNull().default(false),
  feedbackUnlocks: integer("feedback_unlocks").notNull().default(0),
  feedbackRejected: integer("feedback_rejected").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.userId, table.date] }),
]);
