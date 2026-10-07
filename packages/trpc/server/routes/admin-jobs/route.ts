import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { developerProcedure, router } from "../../trpc.js";
import {
  findJob,
  listJobsForClient,
  listAllTargets,
  listRecentRuns,
  resolveTargetByEmail,
  startJob,
  countActiveRuns,
} from "@repo/services/admin-jobs/index.js";

/**
 * The maintenance-job surface for the developer interface.
 *
 * EVERY procedure here is a `developerProcedure`, which rejects anyone whose
 * platformRole is not DEVELOPER. That is the authoritative gate — the route
 * layout's notFound() hides the page, but hiding is not protection, and this is
 * what actually stops a crafted request.
 *
 * Nothing the client sends becomes a command. `jobId` is resolved against the
 * in-code catalogue and rejected if absent; `targetEmail` is resolved against
 * the tenant table and rejected if it does not match a real mailbox. There is
 * no free-text path from this API to anything executable.
 */
export const adminJobsRouter = router({
  /** The catalogue, including jobs that are listed but not web-runnable. */
  list: developerProcedure.query(() => listJobsForClient()),

  /** Mailboxes this deployment owns, for the target picker. */
  targets: developerProcedure.query(async ({ ctx }) => {
    const targets = await listAllTargets(process.env.MAILROID_ENV ?? "local");
    return { targets, ownerEnv: process.env.MAILROID_ENV ?? "local", count: targets.length };
  }),

  /**
   * Read-only forecast. Safe to call on selection, which is why the UI can make
   * seeing an estimate a precondition of arming anything.
   */
  estimate: developerProcedure
    .input(z.object({ jobId: z.string(), targetEmail: z.string().email().optional(), allUsers: z.boolean() }))
    .mutation(async ({ input }) => {
      const job = findJob(input.jobId);
      if (!job?.runner) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Job is not runnable from the web" });
      }

      const targets = input.allUsers
        ? await listAllTargets(process.env.MAILROID_ENV ?? "local")
        : await (async () => {
            if (!input.targetEmail) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "A target mailbox is required" });
            }
            const t = await resolveTargetByEmail(input.targetEmail);
            if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "No connected mailbox for that address" });
            return [t];
          })();

      if (input.allUsers && !job.supportsAllUsers) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This job may not target all users" });
      }

      // Estimated per target and summed, not sampled and multiplied: mailboxes
      // differ by orders of magnitude and an average would mislead on exactly
      // the run where the number matters.
      const per: Record<string, { rows: number; units: number }> = {};
      let rows = 0;
      let units = 0;
      let note: string | undefined;

      for (const t of targets) {
        const e = await job.runner.estimate(t.userId);
        per[t.userId] = { rows: e.rows, units: e.units };
        rows += e.rows;
        units += e.units;
        note ??= e.note;
      }

      return { targets: targets.length, rows, units, note, per };
    }),

  /** Queue the job. Returns immediately; the work happens on Inngest. */
  run: developerProcedure
    .input(
      z.object({
        jobId: z.string(),
        targetEmail: z.string().email().optional(),
        allUsers: z.boolean(),
        dryRun: z.boolean(),
        /**
         * Must equal the mailbox address, or the literal phrase for an
         * all-users run. Checked server-side as well as in the UI — a
         * confirmation enforced only in the browser confirms nothing.
         */
        confirmation: z.string(),
        estimates: z.record(z.string(), z.object({ rows: z.number(), units: z.number() })).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const job = findJob(input.jobId);
      if (!job?.runner) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Job is not runnable from the web" });
      }

      const ownerEnv = process.env.MAILROID_ENV ?? "local";

      const targets = input.allUsers
        ? await listAllTargets(ownerEnv)
        : await (async () => {
            if (!input.targetEmail) {
              throw new TRPCError({ code: "BAD_REQUEST", message: "A target mailbox is required" });
            }
            const t = await resolveTargetByEmail(input.targetEmail);
            if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "No connected mailbox for that address" });
            return [t];
          })();

      // The typed confirmation. An all-users run names how many mailboxes it
      // will touch, so the phrase cannot be muscle-memory from a smaller run.
      const expected = input.allUsers
        ? `ALL ${targets.length}`
        : (input.targetEmail ?? "").trim().toLowerCase();
      if (input.confirmation.trim().toLowerCase() !== expected.toLowerCase()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Confirmation did not match. Type exactly: ${expected}`,
        });
      }

      // One fan-out of a given job at a time. Two overlapping sweeps would
      // double-spend quota on the same mailboxes and interleave their audit
      // rows into something nobody can read afterwards.
      if (await countActiveRuns(input.jobId)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That job already has runs queued or in progress. Wait for them to finish.",
        });
      }

      return startJob({
        jobId: input.jobId,
        actor: { userId: ctx.user.id, email: ctx.user.email ?? "unknown" },
        targets,
        allUsers: input.allUsers,
        dryRun: input.dryRun,
        estimates: input.estimates,
      });
    }),

  /** Audit history, newest first. */
  runs: developerProcedure
    .input(z.object({ limit: z.number().min(1).max(200).optional() }).optional())
    .query(({ input }) => listRecentRuns(input?.limit ?? 50)),
});
