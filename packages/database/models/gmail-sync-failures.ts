import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Threads a sync failed to fetch, kept until they are fetched or given up on.
 *
 * WHY THIS EXISTS. Initial sync used to log "thread fetch failed, skipping" and
 * move on, with no record anywhere. On 2026-10-01 mailbox 008 lost seven
 * threads that way: a quota 403 arrived mid-sync, the thread was skipped, and
 * nothing would ever look for it again. A row here is the promise that it will.
 *
 * One row per (tenant, thread), so recording the same failure twice — a page
 * step retried by Inngest, a duplicate retry event — updates rather than
 * duplicates.
 *
 * Status:
 *   pending  — owed a retry; picked up once next_attempt_at has passed
 *   done     — fetched and stored, or found already stored
 *   terminal — given up on: access genuinely denied, the thread is gone, or
 *              attempts exhausted. Stays visible; an operator resets it to
 *              pending to try again.
 */
export const gmailSyncFailures = pgTable(
  "gmail_sync_failures",
  {
    tenantId: text("tenant_id").notNull(),
    threadId: text("thread_id").notNull(),

    // 'initial-sync' | 'operator'
    source: text("source").notNull(),
    // 'quota' | 'permission' | 'gone' | 'other' — what the LAST attempt hit.
    kind: text("kind").notNull(),
    // 'pending' | 'done' | 'terminal'
    status: text("status").notNull().default("pending"),

    attempts: integer("attempts").notNull().default(0),
    // Never retried before this instant. For a quota failure it is the
    // mailbox's cooldown end, so a retry cannot land inside Google's window.
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),

    // Status and reason only, truncated. Never a response body: those can carry
    // message content.
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.threadId] }),
    // The retry sweep's only query: what is due, now.
    index("idx_gsf_due").on(table.status, table.nextAttemptAt),
  ],
);
