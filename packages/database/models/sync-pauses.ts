import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Operator kill switch: stop talking to Google, for one mailbox or for
 * everything.
 *
 * PRESENCE OF A ROW MEANS PAUSED. Clearing a pause is a DELETE, not a column
 * flip — a boolean `enabled` plus an `expires_at` in the past has two ways to
 * spell "not paused" and every reader has to get both right. There is exactly
 * one representation here.
 *
 * Three things needed this and got one mechanism:
 *   - letting a rate-limited mailbox go genuinely silent so a Gmail penalty
 *     window can lapse (every call inside it pushes the window further out)
 *   - stopping a local dev server from burning prod's per-user Gmail quota:
 *     both share a GOOGLE_CLIENT_ID, so they share one quota bucket per mailbox
 *   - account deactivation
 */
export const syncPauses = pgTable(
  "sync_pauses",
  {
    // Surrogate, defaulted in SQL so an operator can INSERT without inventing
    // one — these rows are written by hand at a psql prompt far more often than
    // by application code.
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),

    // Explicit rather than encoding "global" as a magic tenant_id value. A
    // sentinel string means every future reader has to know that one id is not
    // a tenant; a column means the query says what it means.
    scope: text("scope").notNull(), // 'global' | 'tenant'
    tenantId: text("tenant_id"), // NULL iff scope = 'global'

    // 'sync'        — no Google calls; the app still works on cached data
    // 'disabled'    — no Google calls and no app access (deactivated account)
    // 'maintenance' — the above, for everyone (scope must be 'global')
    mode: text("mode").notNull(),

    reason: text("reason"),
    // Answers "who paused this, and why is it still on?" months later. Rows are
    // created by raw SQL, so the app never sees the insert and cannot log it —
    // this column is the only durable record of intent.
    createdBy: text("created_by"),

    // users.watch keeps the Pub/Sub SUBSCRIPTION alive; it does not read
    // mailbox contents. Blocking it by default would be wrong: a pause outliving
    // the 48h renewal slack would silently kill the subscription for no benefit.
    // Set true only when zero Google traffic is the actual goal (proving a
    // quota penalty), or for a deactivated account whose watch should lapse.
    blockWatchRenewal: boolean("block_watch_renewal").notNull().default(false),

    // NULL = until manually cleared (deactivation). Set it for timed pauses.
    // An expired row reads exactly like an absent one; nothing is required to
    // delete it for service to resume, because recovery that depends on a
    // cleanup step turns a failed cleanup into a permanent outage.
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One global pause at a time, and one per mailbox — a second INSERT fails
    // rather than leaving two rows whose precedence someone has to reason about.
    uniqueIndex("sync_pauses_one_global")
      .on(table.scope)
      .where(sql`${table.scope} = 'global'`),
    uniqueIndex("sync_pauses_one_per_tenant")
      .on(table.tenantId)
      .where(sql`${table.tenantId} is not null`),
    // Read on every Gmail call via getPause().
    index("idx_sync_pauses_tenant").on(table.tenantId),
  ],
);
