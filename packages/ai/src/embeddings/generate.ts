import OpenAI from "openai";
import 'dotenv/config';
import { tagClientProvider, embeddingsCreate } from "../usage/track.ts";
import type { UsageMeta } from "../usage/track.ts";

/**
 * The embedding client. Separate from the chat client (client.ts) because the
 * two can legitimately point at different providers — embeddings are often
 * cheapest somewhere other than where the best chat model lives.
 *
 * Any OpenAI-compatible embeddings endpoint works, hosted or local.
 *
 *   EMBEDDINGS_PROVIDER — label recorded in `ai_usage.provider`. Falls back to
 *                         AI_PROVIDER when both run on the same provider.
 *   EMBEDDINGS_API_KEY  — required.
 *   EMBEDDINGS_BASE_URL — required.
 *   EMBEDDINGS_MODEL    — required; must match the `vector(1536)` column's
 *                         dimensions, so changing it is a migration, not a
 *                         config change.
 */
// .trim() — `docker run --env-file` keeps trailing whitespace, which would
// corrupt the base URL / model name (see client.ts for the 404 this causes).
export const client = tagClientProvider(
  new OpenAI({
    apiKey: (process.env.EMBEDDINGS_API_KEY ?? "").trim(),
    baseURL: (process.env.EMBEDDINGS_BASE_URL ?? "").trim() || undefined,
  }),
  (process.env.EMBEDDINGS_PROVIDER ?? process.env.AI_PROVIDER ?? "").trim() || "unconfigured",
);

const MODEL = (process.env.EMBEDDINGS_MODEL ?? "").trim();

/**
 * Generate an embedding vector for a single text string.
 *
 * @param text - The text to embed (subject + body combined)
 * @param meta - Usage attribution: which feature is generating this embedding.
 * @returns number[] - 1536-dimensional embedding vector
 */
export async function createEmbedding(text: string, meta: UsageMeta): Promise<number[]> {
  const response = await embeddingsCreate(client, { model: MODEL, input: text }, meta);

  return response.data[0]!.embedding;
}

/**
 * Generate embeddings for multiple texts in a single API call.
 * Much more efficient than calling createEmbedding one at a time.
 *
 * @param texts - Array of text strings to embed
 * @param meta - Usage attribution: which feature is generating these embeddings.
 * @returns Array of embedding vectors (same order as input)
 */
export async function createEmbeddingsBatch(texts: string[], meta: UsageMeta): Promise<number[][]> {
  const response = await embeddingsCreate(client, { model: MODEL, input: texts }, meta);

  return response.data.map((d) => d.embedding);
}
