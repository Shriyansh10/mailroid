import { inngest } from "@repo/inngest";
import { generateEmbeddingsForEntities } from "./index.ts";

/**
 * Embeds exactly the entityIds a hydrate batch just fetched bodies for.
 * OpenAI-bound, not Gmail- or LLM-bound — its own concurrency knob so a slow
 * embeddings provider never backs up hydration or classification.
 *
 * Uses generateEmbeddingsForEntities (a bounded id set), not the user-global
 * generateMissingEmbeddings — that does a full-table scan per call and its
 * overlap guard is process-local, which breaks the moment this runs across
 * more than one API container.
 */
export const indexBatch = inngest.createFunction(
  {
    id: "index-batch",
    concurrency: { limit: Number(process.env.INDEX_BATCH_CONCURRENCY ?? 3) },
    retries: 4,
  },
  { event: "email/index.requested" },
  async ({ event, step }) => {
    const userId: string = event.data.userId;
    const entityIds: string[] = event.data.entityIds;
    const correlationId: string | undefined = event.data.correlationId;

    const result = await step.run("embed-batch", () =>
      generateEmbeddingsForEntities(userId, entityIds),
    );

    return { userId, correlationId, embedded: result.embedded };
  },
);
