import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

// One row per user. Tracks the durable, resumable initial mailbox sync
// (see @repo/services/gmail/initial-sync.ts) so the UI has something to
// poll — before this table existed, the sync's progress and completion were
// known only inside a single Inngest run and were lost the instant it ended.
//
// `status` values: 'queued' | 'running' | 'complete' | 'failed'.
//   - 'queued' is written when the sync is enqueued but hasn't started yet
//     (initial sync runs at concurrency 1, so a second connecting user waits
//     behind the first — without this state the waiting screen looks dead).
//   - 'running' is set by the first run and left alone by every continuation
//     run; only the run that exhausts pagination (nextPageToken == null on
//     every category) writes 'complete'.
//   - 'failed' is written by onFailure once Inngest's retries are exhausted.
//
// `cursor` is jsonb, not a single column, because resuming needs BOTH the
// category index and the Gmail page token — a single value would resume on
// the right page of the wrong category.
//
// `estimatedTotal` comes from Gmail's labels.get (messagesTotal) and is
// display-only. Completion is always nextPageToken == null; label totals use
// search semantics that drift from the sync's own query by a few percent, so
// gating completion on `processed >= estimatedTotal` could leave the UI
// waiting on a total that's never exactly reached.
export const gmailSyncStatus = pgTable("gmail_sync_status", {
  userId: text("user_id").primaryKey(),
  status: text("status").notNull().default("queued"),
  cursor: jsonb("cursor").$type<{ categoryIndex: number; pageToken: string | null } | null>(),
  processed: integer("processed").notNull().default(0),
  estimatedTotal: integer("estimated_total"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
