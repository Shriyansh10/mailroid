/**
 * Retention expiry for what deletion keeps on purpose — run by hand only.
 *
 * Owner decisions (2026-10-31): deletion audit 365 days, developer job runs
 * 90 days, billing per the applicable law (BILLING_RETENTION_DAYS), enforced
 * by a MANUAL command. Nothing schedules `executeRetentionSweep`; a static
 * test (no-automation.test.ts) fails if anything but the CLI calls it.
 *
 *   pnpm admin account:retention                         preview: what is due, what is blocked and why
 *   pnpm admin account:retention --execute --confirm N --as <dev>
 *
 * What each category's expiry does:
 *   DELETION_AUDIT      events deleted; the request cut to a skeleton (id,
 *                       opaque user id, status, kind, timestamps). Not deleted:
 *                       ledger-reconcile reads a missing request as a restore.
 *   SUPPRESSION_MARKER  deleted at its own expires_at, with its resolved reviews.
 *   DEVELOPER_JOB_RUN   deleted. Only runs against an account whose deletion
 *                       COMPLETED; runs against live accounts are untouched.
 *   BILLING_RECORD      deleted. Only pseudonymised rows of deleted subjects,
 *                       and only once BILLING_RETENTION_DAYS is configured.
 *
 * ONE RULE PER CATEGORY. `ELIGIBLE` holds the SQL predicate that decides "due".
 * The preview selects it as a column; execution uses the very same text in the
 * WHERE of the statement that expires the row. So the preview cannot promise
 * something execution would refuse, or the reverse — and execution re-evaluates
 * it at the moment of deletion, after locking the request rows a legal hold is
 * written to (a hold placed after the preview, or while the sweep runs, wins).
 */

import { randomUUID } from "node:crypto";

import { db, pool, eq } from "@repo/database";
import { developerJobRuns } from "@repo/database/models/developer-job-runs";

import {
  DELETION_AUDIT_RETENTION_DAYS,
  DEVELOPER_JOB_RUN_RETENTION_DAYS,
  billingRetentionDays,
  retentionVerdict,
  type RetentionBlock,
  type RetentionCategory,
} from "./policy.ts";
import type { DeletionActor } from "./service.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionItem {
  category: RetentionCategory;
  /** The record's own id (request, marker, job run, billing event). */
  id: string;
  /** The deletion request it belongs to, where there is one. */
  requestId: string | null;
  since: Date;
  ageDays: number;
  action: string;
  due: boolean;
  block?: RetentionBlock;
  dueAt?: Date | null;
}

export interface RetentionPreview {
  now: Date;
  billingDays: number | null;
  items: RetentionItem[];
}

const ACTION: Record<RetentionCategory, string> = {
  DELETION_AUDIT: "delete the audit events; cut the request to a skeleton",
  SUPPRESSION_MARKER: "delete the suppression marker (and its resolved reviews)",
  DEVELOPER_JOB_RUN: "delete the job run",
  BILLING_RECORD: "delete the pseudonymised billing record",
};

const TERMINAL = `('WITHDRAWN','REJECTED','CANCELLED','COMPLETED')`;

/** `$1` = now, `$2` = period in days (NULL: no period). */
const CUTOFF = `($1::timestamptz - make_interval(days => $2::int))`;

/**
 * The eligibility predicates. `$1` is now and `$2` the period in days in every
 * one of them; each names its table by the alias shown.
 */
const ELIGIBLE: Record<RetentionCategory, string> = {
  // alias r = account_deletion_request
  DELETION_AUDIT: `r.status IN ${TERMINAL} AND r.closed_at IS NOT NULL AND r.audit_expired_at IS NULL
    AND r.legal_hold_at IS NULL AND r.closed_at <= ${CUTOFF}`,
  // alias s = deletion_suppression. Its own expires_at decides; $2 is unused but typed.
  SUPPRESSION_MARKER: `s.expires_at <= $1::timestamptz AND $2::int IS NULL
    AND NOT EXISTS (SELECT 1 FROM deletion_reregistration_review v WHERE v.suppression_id = s.id AND v.status = 'OPEN')
    AND NOT EXISTS (SELECT 1 FROM account_deletion_request h WHERE h.id = s.request_id AND h.legal_hold_at IS NOT NULL)`,
  // alias j = developer_job_runs
  DEVELOPER_JOB_RUN: `j.created_at <= ${CUTOFF}
    AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = j.target_user_id)
    AND EXISTS (SELECT 1 FROM account_deletion_request h WHERE h.user_id = j.target_user_id AND h.status = 'COMPLETED' AND h.closed_at <= ${CUTOFF})
    AND NOT EXISTS (SELECT 1 FROM account_deletion_request h WHERE h.user_id = j.target_user_id AND h.legal_hold_at IS NOT NULL)`,
  // alias b = billing_event. No period configured ⇒ $2 IS NULL ⇒ never eligible.
  BILLING_RECORD: `$2::int IS NOT NULL AND b.subject_type = 'USER' AND b.subject_id LIKE 'deleted:%' AND b.occurred_at <= ${CUTOFF}
    AND NOT EXISTS (SELECT 1 FROM account_deletion_request h
                     WHERE h.email_hash IS NOT NULL AND b.subject_id = 'deleted:' || left(h.email_hash, 16) AND h.legal_hold_at IS NOT NULL)`,
};

/** The period for each category, as `$2`. */
function period(category: RetentionCategory, billingDays: number | null): number | null {
  if (category === "DELETION_AUDIT") return DELETION_AUDIT_RETENTION_DAYS;
  if (category === "DEVELOPER_JOB_RUN") return DEVELOPER_JOB_RUN_RETENTION_DAYS;
  if (category === "BILLING_RECORD") return billingDays;
  return null;
}

/** Every candidate per category, with `due` computed by ELIGIBLE and the facts the block label needs. */
const CANDIDATES: Record<RetentionCategory, string> = {
  DELETION_AUDIT: `SELECT r.id, r.id AS request_id, r.closed_at AS since, NULL::timestamptz AS expires_at,
      r.legal_hold_at IS NOT NULL AS held, false AS open_review, (${ELIGIBLE.DELETION_AUDIT}) AS due
    FROM account_deletion_request r
    WHERE r.status IN ${TERMINAL} AND r.closed_at IS NOT NULL AND r.audit_expired_at IS NULL`,
  SUPPRESSION_MARKER: `SELECT s.id, s.request_id, s.created_at AS since, s.expires_at,
      EXISTS (SELECT 1 FROM account_deletion_request h WHERE h.id = s.request_id AND h.legal_hold_at IS NOT NULL) AS held,
      EXISTS (SELECT 1 FROM deletion_reregistration_review v WHERE v.suppression_id = s.id AND v.status = 'OPEN') AS open_review,
      (${ELIGIBLE.SUPPRESSION_MARKER}) AS due
    FROM deletion_suppression s`,
  DEVELOPER_JOB_RUN: `SELECT j.id, r.id AS request_id, greatest(j.created_at, r.closed_at) AS since, NULL::timestamptz AS expires_at,
      EXISTS (SELECT 1 FROM account_deletion_request h WHERE h.user_id = j.target_user_id AND h.legal_hold_at IS NOT NULL) AS held,
      false AS open_review, (${ELIGIBLE.DEVELOPER_JOB_RUN}) AS due
    FROM developer_job_runs j
    JOIN account_deletion_request r ON r.user_id = j.target_user_id AND r.status = 'COMPLETED' AND r.closed_at IS NOT NULL
    WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = j.target_user_id)`,
  BILLING_RECORD: `SELECT b.id,
      (SELECT min(h.id::text) FROM account_deletion_request h WHERE h.email_hash IS NOT NULL AND b.subject_id = 'deleted:' || left(h.email_hash, 16)) AS request_id,
      b.occurred_at AS since, NULL::timestamptz AS expires_at,
      EXISTS (SELECT 1 FROM account_deletion_request h WHERE h.email_hash IS NOT NULL AND b.subject_id = 'deleted:' || left(h.email_hash, 16) AND h.legal_hold_at IS NOT NULL) AS held,
      false AS open_review, (${ELIGIBLE.BILLING_RECORD}) AS due
    FROM billing_event b
    WHERE b.subject_type = 'USER' AND b.subject_id LIKE 'deleted:%'`,
};

const CATEGORIES: RetentionCategory[] = ["DELETION_AUDIT", "SUPPRESSION_MARKER", "DEVELOPER_JOB_RUN", "BILLING_RECORD"];

/** Everything retention covers, due or not, with the reason it is not due. Read-only. */
export async function previewRetention(opts: { now?: Date; env?: NodeJS.ProcessEnv } = {}): Promise<RetentionPreview> {
  const now = opts.now ?? new Date();
  const billingDays = billingRetentionDays(opts.env);
  const items: RetentionItem[] = [];
  for (const category of CATEGORIES) {
    const days = period(category, billingDays);
    const res = await pool.query<{ id: string; request_id: string | null; since: Date; expires_at: Date | null; held: boolean; open_review: boolean; due: boolean }>(
      CANDIDATES[category],
      [now, days],
    );
    for (const r of res.rows) {
      const it: RetentionItem = {
        category,
        id: r.id,
        requestId: r.request_id,
        since: r.since,
        ageDays: Math.floor((now.getTime() - r.since.getTime()) / DAY_MS),
        action: ACTION[category],
        due: r.due,
      };
      if (!r.due) {
        // The label only: `due` itself is the SQL predicate's answer.
        const v = retentionVerdict({ category, since: r.since, now, legalHold: r.held, openReview: r.open_review, billingDays, expiresAt: r.expires_at ?? undefined });
        it.block = v.due ? "NOT_YET_DUE" : v.block;
        it.dueAt = v.due ? null : v.dueAt;
      }
      items.push(it);
    }
  }
  return { now, billingDays, items };
}

export interface SweepResult {
  jobRunId: string;
  done: RetentionItem[];
  /** Due at preview, no longer eligible at execution (held since, already done). Not an error. */
  unchanged: RetentionItem[];
  failed: { item: RetentionItem; error: string }[];
}

/**
 * Expire every due item. `confirmCount` must equal the number due right now:
 * the operator types back the number the preview showed, and a mismatch (the
 * data changed in between) refuses before anything is touched.
 *
 * Each item is its own transaction. One failure doesn't stop the rest; the
 * result lists it with the full error, the job run ends FAILED, and running
 * the sweep again picks up exactly what is still due.
 */
export async function executeRetentionSweep(input: {
  actor: DeletionActor;
  confirmCount: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam only: pause an item just before it takes its locks, or just
   * after (still inside its transaction). retention.postgres.test.ts uses it to
   * order a concurrent legal hold deterministically against the sweep.
   */
  hooks?: SweepHooks;
}): Promise<SweepResult> {
  if (input.actor.type !== "DEVELOPER") throw new RetentionError("FORBIDDEN", "Only a developer can run the retention sweep.");
  const preview = await previewRetention({ now: input.now, env: input.env });
  const due = preview.items.filter((i) => i.due);
  if (input.confirmCount !== due.length) {
    throw new RetentionError(
      "CONFIRMATION_MISMATCH",
      `${due.length} item(s) are due now, but --confirm says ${input.confirmCount}. Run the preview again and confirm the number it shows.`,
    );
  }

  const [run] = await db
    .insert(developerJobRuns)
    .values({
      batchId: randomUUID(),
      jobId: "account:retention",
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      status: "RUNNING",
      estimatedRows: due.length,
      startedAt: new Date(),
    })
    .returning({ id: developerJobRuns.id });

  const result: SweepResult = { jobRunId: run!.id, done: [], unchanged: [], failed: [] };
  for (const it of due) {
    try {
      const changed = await expire(it, preview.now, preview.billingDays, input.hooks);
      (changed ? result.done : result.unchanged).push(it);
    } catch (err) {
      result.failed.push({ item: it, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    }
  }

  const byCategory: Record<string, number> = {};
  for (const it of result.done) byCategory[it.category] = (byCategory[it.category] ?? 0) + 1;
  await db
    .update(developerJobRuns)
    .set({
      status: result.failed.length ? "FAILED" : "SUCCEEDED",
      processed: due.length,
      succeeded: result.done.length,
      failed: result.failed.length,
      details: { expired: byCategory, unchanged: result.unchanged.length, billingRetentionDays: preview.billingDays },
      error: result.failed.length ? result.failed.map((f) => `${f.item.category} ${f.item.id}: ${f.error}`).join("\n\n") : null,
      finishedAt: new Date(),
    })
    .where(eq(developerJobRuns.id, run!.id));
  return result;
}

export interface SweepHooks {
  beforeLock?(item: RetentionItem): Promise<void>;
  afterLock?(item: RetentionItem): Promise<void>;
}

export class RetentionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RetentionError";
  }
}

/**
 * The request rows a legal hold on this item would be written to, locked
 * FOR UPDATE before the expiring statement runs. `setLegalHold` updates the
 * same rows, so a hold either commits first — and the expiring statement,
 * which starts after the lock with a fresh snapshot, sees it — or waits until
 * this item is done.
 */
const LOCK_REQUESTS: Record<RetentionCategory, string> = {
  DELETION_AUDIT: `SELECT 1 FROM account_deletion_request WHERE id = $1::uuid FOR UPDATE`,
  SUPPRESSION_MARKER: `SELECT 1 FROM account_deletion_request r JOIN deletion_suppression s ON s.request_id = r.id WHERE s.id = $1::uuid FOR UPDATE OF r, s`,
  DEVELOPER_JOB_RUN: `SELECT 1 FROM account_deletion_request r JOIN developer_job_runs j ON j.target_user_id = r.user_id WHERE j.id = $1::uuid FOR UPDATE OF r`,
  BILLING_RECORD: `SELECT 1 FROM account_deletion_request r JOIN billing_event b ON b.subject_id = 'deleted:' || left(r.email_hash, 16) WHERE b.id = $1::uuid FOR UPDATE OF r`,
};

/** One item: lock, then the category's statement with ELIGIBLE in its WHERE. True if it changed something. */
async function expire(it: RetentionItem, now: Date, billingDays: number | null, hooks?: SweepHooks): Promise<boolean> {
  const days = period(it.category, billingDays);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await hooks?.beforeLock?.(it);
    await client.query(LOCK_REQUESTS[it.category], [it.id]);
    await hooks?.afterLock?.(it);
    let changed = false;
    switch (it.category) {
      case "DELETION_AUDIT": {
        const r = await client.query(
          `UPDATE account_deletion_request r
              SET email = NULL, email_hash = NULL, google_sub_hash = NULL, reason = NULL, details = NULL,
                  org_context = jsonb_build_object('type', org_context->>'type'),
                  org_confirmed_by = NULL, org_outcome = NULL, steps = '{}'::jsonb,
                  accepted_unresolved = NULL, report = NULL, last_error = NULL, decided_by = NULL,
                  audit_expired_at = $1
            WHERE r.id = $3 AND ${ELIGIBLE.DELETION_AUDIT}`,
          [now, days, it.id],
        );
        changed = (r.rowCount ?? 0) > 0;
        if (changed) await client.query(`DELETE FROM account_deletion_event WHERE request_id = $1`, [it.id]);
        break;
      }
      case "SUPPRESSION_MARKER": {
        const r = await client.query(`DELETE FROM deletion_suppression s WHERE s.id = $3 AND ${ELIGIBLE.SUPPRESSION_MARKER}`, [now, days, it.id]);
        changed = (r.rowCount ?? 0) > 0;
        break;
      }
      case "DEVELOPER_JOB_RUN": {
        const r = await client.query(`DELETE FROM developer_job_runs j WHERE j.id = $3 AND ${ELIGIBLE.DEVELOPER_JOB_RUN}`, [now, days, it.id]);
        changed = (r.rowCount ?? 0) > 0;
        break;
      }
      case "BILLING_RECORD": {
        const r = await client.query(`DELETE FROM billing_event b WHERE b.id = $3 AND ${ELIGIBLE.BILLING_RECORD}`, [now, days, it.id]);
        changed = (r.rowCount ?? 0) > 0;
        break;
      }
    }
    await client.query("COMMIT");
    return changed;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
