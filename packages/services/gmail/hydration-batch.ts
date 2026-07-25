import { inngest } from "@repo/inngest";
import { runHydrationBatch } from "./hydration.ts";

/**
 * Historical body hydration — fired in PARALLEL with
 * classification/batch.requested by startClassificationJob (see
 * classification.ts), not chained after it. Classification never reads the
 * body, so gating hydration on classification finishing would only slow
 * embeddings down for no reason.
 *
 * Deliberately its own function, not a step inside classificationBatch:
 * different rate-limit domain (Gmail quota vs LLM tokens), different retry
 * policy, and — critically — a transient Gmail failure here must never
 * touch classification_attempts. Sharing a step would let a retried hydrate
 * step re-bump that counter and push good emails to FAILED at
 * MAX_CLASSIFICATION_ATTEMPTS for a reason that had nothing to do with them.
 *
 * Owns its own continuation loop, keyed on message_metadata.hydration_status
 * — independent of classification's own PENDING count. Emits
 * email/index.requested with only the ids that actually got a body this
 * batch (never the claimed set), so indexing never chases a body a Gmail
 * failure left absent.
 */
export const hydrateBatch = inngest.createFunction(
  {
    id: "hydrate-batch",
    // Gmail-bound, not LLM-bound — can run alongside classification-batch's
    // concurrency-1 LLM queue without either throttling the other.
    concurrency: { limit: Number(process.env.HYDRATION_BATCH_CONCURRENCY ?? 3) },
    retries: 4,
  },
  { event: "email/hydrate.requested" },
  async ({ event, step }) => {
    const userId: string = event.data.userId;
    const since = new Date(event.data.since);
    const correlationId: string | undefined = event.data.correlationId;

    const outcome = await step.run("hydrate-batch", () =>
      runHydrationBatch(userId, since, correlationId),
    );

    if (outcome.hydratedEntityIds.length > 0) {
      await step.sendEvent("request-indexing", {
        name: "email/index.requested",
        data: { userId, correlationId, entityIds: outcome.hydratedEntityIds },
      });
    }

    if (outcome.attempted === 0) {
      // Nothing left to select for this window.
      return { userId, done: true };
    }

    if (outcome.remaining > 0) {
      await step.sendEvent("continue-hydrate-batch", {
        name: "email/hydrate.requested",
        data: { userId, since: since.toISOString(), correlationId },
      });
      return { userId, continued: true, remaining: outcome.remaining };
    }

    return { userId, done: true };
  },
);
