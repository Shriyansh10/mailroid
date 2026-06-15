import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Tracks which Google account email is connected to each plugin per user.
 * Populated after OAuth callback succeeds.
 */
export const corsairConnectionEmails = pgTable("corsair_connection_emails", {
  userId: text("user_id").primaryKey(),
  gmailEmail: text("gmail_email"),
  calendarEmail: text("calendar_email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
