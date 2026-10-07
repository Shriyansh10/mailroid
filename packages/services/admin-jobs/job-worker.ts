/**
 * Executes one maintenance job against one mailbox.
 *
 * ONE EVENT PER MAILBOX, NOT PER BATCH. An "all users" run emits N events, so
 * Inngest's own concurrency controls pace the fan-out and one dead mailbox
 * cannot stall the other 299. It also means a retry retries that mailbox, not
 * the whole sweep.
 *
 * CONCURRENCY IS KEYED ON THE MAILBOX. Gmail's rate limit is per-user, so
 * separate mailboxes genuinely do not contend and there is no reason to
 * serialise them globally. What must never happen is two jobs racing on the
 * same mailbox, so that — and only that — is limited to one.
 *
 * The outer limit is there for us rather than for Google: it bounds how much of
 * this box's own capacity a fan-out can take while live traffic is being
 * served.
 */

import { inngest } from "@repo/inngest";
import { db, eq } from "@repo/database";
import { developerJobRuns } from "@repo/database/models/developer-job-runs";
import { logger } from "@repo/logger";

import { getAuthFailure } from "../gmail/quota-cooldown.ts";
import { findJob } from "./registry.ts";

export const adminJobWorker = inngest.createFunction(
  {
    id: "admin-job-run",
    concurrency: [
      // Total share of this deployment a fan-out may occupy.
      { limit: Number(process.env.ADMIN_JOB_CONCURRENCY ?? 2) },
      // Never two jobs on one mailbox at once.
      { key: "event.data.userId", limit: 1 },
    ],
    // Deliberately low. These jobs are resumable by construction — their cursor
    // is "work still outstanding" — so a failure is better re-queued by a human
    // who has read the audit row than retried five times into a mailbox whose
    // credentials are dead.
    retries: 1,
  },
  { event: "admin/job.requested" },
  async ({ event, step }) => {
    const runId: string = event.data.runId;
    const jobId: string = event.data.jobId;
    const userId: string = event.data.userId;
    const dryRun: boolean = Boolean(event.data.dryRun);

    const job = findJob(jobId);
    if (!job?.runner) {
      // Not retryable: the catalogue is code, so a missing id means the event
      // outlived a deploy that removed the job. Record it and stop.
      await db
        .update(developerJobRuns)
        .set({
          status: "FAILED",
          error: `Job "${jobId}" is not runnable in this deployment`,
          finishedAt: new Date(),
        })
        .where(eq(developerJobRuns.id, runId));
      return { ok: false, reason: "unknown-job" };
    }

    /**
     * A mailbox whose credentials are dead cannot be fixed by anything on this
     * page, and attempting it produces a red stack trace that reads like the
     * job is broken when the job is fine.
     *
     * Only the USER can repair this, by reconnecting — and reconnecting also
     * re-registers the watch (see the startGmailWatch call in the Gmail OAuth
     * callback), so for this class of mailbox the remedy is the same one that
     * would have made the job unnecessary. Spending calls to rediscover that is
     * pure waste: the earlier recipient backfill burned 33 of them to learn it
     * once per row.
     *
     * Checked here rather than per job so every quota-spending job in the
     * catalogue inherits it, including ones added later.
     */
    if (job.risk === "spends-quota" && !job.runsDespiteAuthFailure) {
      const authFailure = await getAuthFailure(userId);
      if (authFailure) {
        await db
          .update(developerJobRuns)
          .set({
            status: "CANCELLED",
            processed: 1,
            succeeded: 0,
            failed: 0,
            details: {
              skipped: true,
              reason: "needs-reconnect",
              message:
                "This mailbox's Google credentials have lapsed. Only the user can fix it, by reconnecting Gmail in Settings — which also re-registers the watch. No admin action here can help.",
              authFailedAt: authFailure.at.toISOString(),
            },
            startedAt: new Date(),
            finishedAt: new Date(),
          })
          .where(eq(developerJobRuns.id, runId));

        logger.info("[ADMIN_JOB] skipped, mailbox needs reconnection", {
          runId, jobId, userId, authFailedAt: authFailure.at.toISOString(),
        });
        return { ok: true, skipped: "needs-reconnect" };
      }
    }

    await step.run("mark-running", async () => {
      await db
        .update(developerJobRuns)
        .set({ status: "RUNNING", startedAt: new Date() })
        .where(eq(developerJobRuns.id, runId));
    });

    try {
      const result = await step.run("execute", () =>
        job.runner!.run(userId, {
          dryRun,
          // Progress lands on the audit row itself, so a long run is observable
          // from the history table rather than only from logs.
          onProgress: async (p) => {
            await db
              .update(developerJobRuns)
              .set({
                processed: p.processed,
                succeeded: p.succeeded,
                failed: p.failed,
                details: p.details,
              })
              .where(eq(developerJobRuns.id, runId));
          },
        }),
      );

      await db
        .update(developerJobRuns)
        .set({
          status: "SUCCEEDED",
          processed: result.processed,
          succeeded: result.succeeded,
          failed: result.failed,
          details: result.details,
          // A run that completed with per-row failures is still a completed
          // run, but the failures must not vanish into a success.
          error: result.errors?.length ? result.errors.join("\n") : null,
          finishedAt: new Date(),
        })
        .where(eq(developerJobRuns.id, runId));

      logger.info("[ADMIN_JOB] finished", {
        runId, jobId, userId, dryRun,
        processed: result.processed, succeeded: result.succeeded, failed: result.failed,
      });

      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      await db
        .update(developerJobRuns)
        .set({ status: "FAILED", error: message, finishedAt: new Date() })
        .where(eq(developerJobRuns.id, runId));

      logger.error("[ADMIN_JOB] failed", { runId, jobId, userId, error: message });
      throw err;
    }
  },
);
