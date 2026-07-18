import { inngest } from "@repo/inngest";
import {
  runClassificationBatch,
  setJobProgress,
  markJobComplete,
  markJobFailed,
} from "./classification.js";

/**
 * Historical bulk classification ("Classify Last Week" / "Classify Last
 * Month"), user-initiated from the priority inbox. One run processes exactly
 * one batch of up to BATCH_SIZE PENDING emails (see classification.ts) and
 * either completes the job or sends exactly one continuation event — never a
 * fan-out of N batches up front. Mirrors gmailInitialSync's continuation
 * pattern (initial-sync.ts), except a "batch" here is already the atomic
 * unit (unlike sync's cheap pages, an LLM call is expensive enough that
 * grouping several per run isn't worth the risk of a long-running step).
 *
 * The database is the checkpoint (message_metadata.classification_status),
 * not this function's event payload — a lost continuation event just means
 * the job stalls at 'running' until the reconciliation cron (see
 * reconciliation-cron.ts) re-kicks it from the same `since` date, and the
 * next batch picks up exactly where the PENDING rows say to.
 *
 * NOTE: lives in @repo/services (not @repo/inngest), same reasoning as
 * gmailInitialSync — it needs classification.ts from this package, and
 * @repo/services already depends on @repo/inngest, so defining it here keeps
 * that dependency one-directional.
 */
export const classificationBatch = inngest.createFunction(
  {
    id: "classification-batch",
    concurrency: { limit: Number(process.env.CLASSIFICATION_CONCURRENCY ?? 1) },
    retries: 4,
    onFailure: async ({ event }) => {
      // onFailure's event wraps the original triggering event at event.data.event.
      const jobId: string | undefined = event.data.event?.data?.jobId;
      if (jobId) await markJobFailed(jobId);
    },
  },
  { event: "classification/batch.requested" },
  async ({ event, step }) => {
    const jobId: string = event.data.jobId;
    const userId: string = event.data.userId;
    const since = new Date(event.data.since);

    const outcome = await step.run("classify-batch", () =>
      runClassificationBatch(userId, since),
    );

    if (outcome.attempted === 0) {
      // Nothing left to select for this job's scope.
      await step.run("job-complete", () => markJobComplete(jobId));
      return { jobId, done: true };
    }

    await step.run("job-progress", () => setJobProgress(jobId, outcome.remaining));

    if (outcome.remaining > 0) {
      await step.sendEvent("continue-classification-batch", {
        name: "classification/batch.requested",
        data: { jobId, userId, since: since.toISOString() },
      });
      return { jobId, continued: true, remaining: outcome.remaining };
    }

    await step.run("job-complete-done", () => markJobComplete(jobId));
    return { jobId, done: true };
  },
);
