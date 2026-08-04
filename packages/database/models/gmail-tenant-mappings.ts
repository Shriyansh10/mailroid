import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const gmailTenantMappings = pgTable(
  "gmail_tenant_mappings",
  {
    emailAddress: text("email_address").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    lastHistoryId: text("last_history_id"),
    watchExpiration: timestamp("watch_expiration", { withTimezone: true }),

    // Google answers a per-user 429 with an absolute "Retry after <ISO>", and
    // retrying inside that window pushes the window FORWARD rather than
    // resetting it. Persisting the instant lets every Gmail caller skip the
    // call entirely until it passes — which is the only thing that lets a
    // throttled mailbox recover. Same "skip until time X" shape as
    // watchExpiration above.
    quotaCooldownUntil: timestamp("quota_cooldown_until", { withTimezone: true }),
    quotaCooldownReason: text("quota_cooldown_reason"), // GMAIL_429 | MANUAL

    // Durable webhook health. The /api/webhook route acks 200 even when
    // processing failed (a non-2xx makes Pub/Sub redeliver every ~15s for
    // 7 days, which amplifies a fault instead of fixing it — see
    // apps/api/src/server.ts). That removes the 500 that used to announce a
    // broken mailbox, so the signal has to live somewhere queryable: an
    // error log is the only other trace and logs rotate. Written on every
    // failure, cleared on the next success, surfaced by /api/_debug/watch-health.
    lastWebhookFailureAt: timestamp("last_webhook_failure_at", { withTimezone: true }),
    lastWebhookFailureReason: text("last_webhook_failure_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The table is keyed by email_address, but the cooldown is read by
    // tenant_id on every Gmail call — an unindexed sequential scan on the hot
    // path otherwise.
    index("idx_gmail_tenant_mappings_tenant").on(table.tenantId),
  ],
);
