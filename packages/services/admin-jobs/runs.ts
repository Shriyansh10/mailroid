/**
 * Starting maintenance jobs, and the audit rows that record them.
 *
 * The orchestration rule that matters: **nothing runs inside the HTTP request.**
 * Starting a job writes QUEUED audit rows and emits one Inngest event per
 * mailbox, then returns. A backfill that takes four minutes must not depend on
 * a browser tab staying open, and an "all users" fan-out across hundreds of
 * mailboxes must be paced by a queue rather than by however fast a `for` loop
 * can open connections.
 */

import { randomUUID } from "node:crypto";

import { db, and, eq, desc, inArray, sql } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { developerJobRuns } from "@repo/database/models/developer-job-runs";
import { inngest } from "@repo/inngest";
import { logger } from "@repo/logger";

import { isMailboxAllowedInThisEnvironment } from "../env.ts";

import { findJob } from "./registry.ts";

export interface JobTarget {
  userId: string;
  email: string;
}

/**
 * Every mailbox this deployment owns.
 *
 * OWNERSHIP IS THE MAILBOX POLICY, NOT `watchOwnerEnv`. This filtered on
 * `watch_owner_env` at first, which was wrong twice over:
 *
 *   1. That column is written when a watch is successfully registered, so a
 *      mailbox that has NEVER registered one has it NULL and was invisible to
 *      an "all users" run. For the renew-watch job those are precisely the
 *      mailboxes most in need of it — the fan-out skipped exactly the rows it
 *      existed to fix.
 *   2. It is not the ownership test anything else uses. watch-cron and
 *      startGmailWatch both ask `isMailboxAllowedInThisEnvironment`, and a
 *      second, subtly different notion of "ours" is how two guards end up
 *      disagreeing about the same mailbox.
 *
 * The allowlist/denylist still does the real job it was introduced for: a
 * developer running locally cannot fan a job out across production mailboxes.
 */
export async function listAllTargets(_ownerEnv?: string): Promise<JobTarget[]> {
  const rows = await db
    .select({
      email: gmailTenantMappings.emailAddress,
      userId: gmailTenantMappings.tenantId,
    })
    .from(gmailTenantMappings);

  return rows
    .filter((r) => isMailboxAllowedInThisEnvironment(r.email))
    .map((r) => ({ userId: r.userId, email: r.email }));
}

/**
 * Resolve one typed address.
 *
 * The ownership check matters here as much as in the fan-out: without it, an
 * operator could reach a mailbox this environment does not own simply by typing
 * its address. `startGmailWatch` would refuse that, but a backfill would not —
 * it would quietly spend another environment's mailbox quota. Returning null
 * means the UI reports "no connected mailbox", which is the correct answer:
 * from here, there isn't one.
 */
export async function resolveTargetByEmail(email: string): Promise<JobTarget | null> {
  const normalised = email.trim().toLowerCase();

  const [row] = await db
    .select({
      email: gmailTenantMappings.emailAddress,
      userId: gmailTenantMappings.tenantId,
    })
    .from(gmailTenantMappings)
    .where(eq(gmailTenantMappings.emailAddress, normalised))
    .limit(1);

  if (!row) return null;
  if (!isMailboxAllowedInThisEnvironment(row.email)) return null;

  return { userId: row.userId, email: row.email };
}

/** Jobs already queued or running, so the UI can refuse to pile another on. */
export async function countActiveRuns(jobId: string): Promise<number> {
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(developerJobRuns)
    .where(
      and(
        eq(developerJobRuns.jobId, jobId),
        inArray(developerJobRuns.status, ["QUEUED", "RUNNING"]),
      ),
    );
  return count;
}

export interface StartJobInput {
  jobId: string;
  actor: { userId: string; email: string };
  targets: JobTarget[];
  allUsers: boolean;
  dryRun: boolean;
  /** What the operator was shown when they armed it, per target. */
  estimates?: Record<string, { rows: number; units: number }>;
}

/**
 * Write the audit rows and hand the work to Inngest.
 *
 * Audit rows are written BEFORE the events are emitted, deliberately. If the
 * process dies between the two, the record shows a QUEUED run that never moved
 * — which is a visible, investigable state. Emitting first and recording second
 * would allow work to happen with no trace of who asked for it, which is the
 * one outcome this table exists to prevent.
 */
export async function startJob(input: StartJobInput): Promise<{ batchId: string; queued: number }> {
  const job = findJob(input.jobId);
  if (!job) throw new Error(`Unknown job: ${input.jobId}`);
  if (!job.runner) throw new Error(`Job ${input.jobId} cannot be run from the web yet`);
  if (input.allUsers && !job.supportsAllUsers) {
    throw new Error(`Job ${input.jobId} may not be run against all users`);
  }
  if (input.targets.length === 0) throw new Error("No targets resolved");

  const batchId = randomUUID();

  const rows = input.targets.map((t) => ({
    batchId,
    jobId: input.jobId,
    actorUserId: input.actor.userId,
    actorEmail: input.actor.email,
    targetUserId: t.userId,
    targetEmail: t.email,
    allUsers: input.allUsers,
    dryRun: input.dryRun,
    status: "QUEUED" as const,
    estimatedRows: input.estimates?.[t.userId]?.rows ?? null,
    estimatedUnits: input.estimates?.[t.userId]?.units ?? null,
  }));

  const inserted = await db
    .insert(developerJobRuns)
    .values(rows)
    .returning({ id: developerJobRuns.id, targetUserId: developerJobRuns.targetUserId });

  logger.info("[ADMIN_JOB] queued", {
    batchId,
    jobId: input.jobId,
    actorEmail: input.actor.email,
    allUsers: input.allUsers,
    dryRun: input.dryRun,
    targets: inserted.length,
  });

  await inngest.send(
    inserted.map((row) => ({
      name: "admin/job.requested" as const,
      data: {
        runId: row.id,
        batchId,
        jobId: input.jobId,
        userId: row.targetUserId!,
        dryRun: input.dryRun,
      },
    })),
  );

  return { batchId, queued: inserted.length };
}

/** Recent runs, newest first. Powers the history table on the developer page. */
export async function listRecentRuns(limit = 50) {
  return db
    .select()
    .from(developerJobRuns)
    .orderBy(desc(developerJobRuns.createdAt))
    .limit(limit);
}
