import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uuid,
  index,
} from "drizzle-orm/pg-core";

import { user } from "./auth.ts";

export const developerJobStatusEnum = pgEnum("developer_job_status", [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

/**
 * Audit trail for maintenance jobs run from the developer interface.
 *
 * WHY THIS EXISTS AT ALL. These jobs spend another person's Gmail quota and
 * write to their mail metadata. Before this, the only way to run one was a CLI
 * on a laptop, where the entire record of "who touched a customer's mailbox,
 * when, and what happened" was a terminal scrollback that nobody kept. A
 * developer surface that makes those jobs one click away without also making
 * them answerable is strictly worse than the CLI it replaces.
 *
 * ONE ROW PER TENANT, NOT PER BATCH. An all-users run fans out to one row per
 * mailbox, sharing a `batchId`. That is deliberate: a run across 300 users that
 * succeeds for 297 and fails for 3 is not a "failed run" or a "successful" one,
 * and a single aggregate row would have to pick a lie. Per-tenant rows make the
 * three failures addressable — and re-runnable — without touching the 297.
 *
 * Rows are never deleted by the app. The whole point is that the record
 * outlives the incident it documents.
 */
export const developerJobRuns = pgTable(
  "developer_job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Groups the per-tenant rows of one fan-out together. Set even for a
     * single-tenant run, so "show me this run" is one query shape rather than
     * two.
     */
    batchId: uuid("batch_id").notNull(),

    /** Registry id of the job, e.g. "gmail:backfill-recipients". */
    jobId: text("job_id").notNull(),

    /**
     * The developer who pressed the button. NOT cascade-deleted with the user:
     * an audit row whose actor can be removed by deleting an account is not an
     * audit row. `set null` keeps the record and loses only the link.
     */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Denormalised so the trail survives the actor's account being deleted. */
    actorEmail: text("actor_email"),

    /** The mailbox this row acted on. */
    targetUserId: text("target_user_id"),
    targetEmail: text("target_email"),

    /**
     * True when the operator asked for every mailbox rather than naming one.
     * Stored rather than inferred from the row count, because "ran against all
     * users" is the fact worth being able to search for later.
     */
    allUsers: boolean("all_users").notNull().default(false),

    /** A dry run reads and reports; it must never write. */
    dryRun: boolean("dry_run").notNull().default(false),

    status: developerJobStatusEnum("status").notNull().default("QUEUED"),

    /**
     * What the estimate predicted when the operator armed the run, kept next to
     * what actually happened. A job that forecast 600 quota units and spent
     * 60,000 is the kind of thing you only catch by storing both.
     */
    estimatedUnits: integer("estimated_units"),
    estimatedRows: integer("estimated_rows"),

    processed: integer("processed").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),

    /** Free-form per-job counters, e.g. { noHeader: 1, gone: 0 }. */
    details: jsonb("details").$type<Record<string, unknown>>(),

    /** Full text of the failure. Errors are documents, not statistics. */
    error: text("error"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The page's default view: most recent first.
    index("idx_djr_created_at").on(t.createdAt),
    // "Show me this fan-out" and "what has been done to this mailbox".
    index("idx_djr_batch").on(t.batchId),
    index("idx_djr_target").on(t.targetUserId, t.createdAt),
  ],
);
