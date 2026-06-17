import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const gmailTenantMappings = pgTable("gmail_tenant_mappings", {
  emailAddress: text("email_address").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  lastHistoryId: text("last_history_id"),
  watchExpiration: timestamp("watch_expiration", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
