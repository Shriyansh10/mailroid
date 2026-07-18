import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// A user-initiated bulk classification run ("Classify Last Week" /
// "Classify Last Month"). One row per job; `message_metadata.classification_*`
// columns are the actual work checkpoint (see models/message-metadata.ts) —
// this table exists purely for progress/ETA display and job identity.
//
// No 'PROCESSING' status here either, for the same reason as
// message_metadata.classification_status: classification concurrency is 1,
// so there are no competing workers to guard against, and a status that a
// crash could leave rows stuck in is worse than not having it.
export const classificationJobs = pgTable(
  "classification_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    scope: text("scope").notNull(), // 'last_week' | 'last_month'
    status: text("status").notNull().default("running"), // 'running' | 'complete' | 'failed'
    // The `received_at >=` threshold, fixed at job creation. Persisted (not
    // recomputed from `scope` on each continuation) so a job resumed by the
    // reconciliation cron hours later still queries the same date window
    // instead of one that's silently drifted forward.
    since: timestamp("since", { withTimezone: true }).notNull(),
    processedCount: integer("processed_count").notNull().default(0),
    totalCount: integer("total_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // A double-click (or a second tab) can't start two chains for the same
    // user — the insert of the second job fails the unique constraint.
    uniqueIndex("classification_jobs_one_active")
      .on(table.userId)
      .where(sql`${table.status} = 'running'`),
  ],
);
