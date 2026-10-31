import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const calendarTenantMappings = pgTable("calendar_tenant_mappings", {
  emailAddress: text("email_address").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  channelId: text("channel_id"),
  resourceId: text("resource_id"),
  watchExpiration: timestamp("watch_expiration", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => [
  // Account deletion purges and verifies by tenant; the PK is the address.
  index("idx_calendar_tenant_mappings_tenant").on(t.tenantId),
]);
