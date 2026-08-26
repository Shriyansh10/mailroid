import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
    quotaCooldownReason: text("quota_cooldown_reason"), // GMAIL_429 | GMAIL_ERROR | MANUAL

    // How many consecutive resume attempts have failed since the cooldown
    // began. Google hands back a fresh independent window on every 429, so
    // trusting each one blindly means landing on the same boundary forever —
    // this is what lets the window escalate (15 -> 30 -> 60min) instead.
    // Reset to 0 the moment ANY Gmail call succeeds (see markGmailHealthy in
    // quota-cooldown.ts) so a resolved incident never taints an unrelated
    // future one.
    quotaResumeFailures: integer("quota_resume_failures").notNull().default(0),
    // Set once when a mailbox transitions from healthy into cooldown, left
    // untouched by later extensions, cleared on recovery. Exists purely to
    // make "how long was this mailbox actually down" computable, and doubles
    // as the seed for the derived per-episode incidentId in log lines.
    quotaCooldownStartedAt: timestamp("quota_cooldown_started_at", { withTimezone: true }),

    // Authentication is a SEPARATE failure mode from quota, and conflating the
    // two is what produced the 2026-08-25 outage: an expired access token came
    // back as 401, was recorded on the quota ladder, and the resulting cooldown
    // blocked the very SDK call that would have refreshed the token — once an
    // hour, indefinitely. These columns exist so an auth failure has somewhere
    // to live that is NOT quota_cooldown_until.
    //
    // Set only after corsair has actually attempted a refresh and failed
    // (invalid_grant, revoked consent, missing client credentials), so a set
    // value means "credentials are dead", never "we didn't try". Cleared by
    // markGmailHealthy on any successful Gmail call. Surfaced by
    // /api/_debug/watch-health as an operator signal — there is no user-facing
    // reconnect flow to route it to.
    gmailAuthFailedAt: timestamp("gmail_auth_failed_at", { withTimezone: true }),
    gmailAuthFailureReason: text("gmail_auth_failure_reason"),

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
