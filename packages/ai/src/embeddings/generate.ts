import OpenAI from "openai";
import 'dotenv/config';
import { tagClientProvider, embeddingsCreate } from "../usage/track.ts";
import type { UsageMeta } from "../usage/track.ts";

/**
 * Provider-agnostic embedding client.
 *
 * Set EMBEDDINGS_BASE_URL to use any OpenAI-compatible provider:
 *
 *   OpenAI (default):     https://api.openai.com/v1
 *   DeepSeek:             https://api.deepseek.com/v1
 *   Claude (via proxy):   https://api.anthropic.com/v1  (if proxy supports embeddings)
 *   Cursor:               https://api.cursor.sh/v1
 *   Local (Ollama):       http://localhost:11434/v1
 *
 * EMBEDDINGS_API_KEY is required for all providers.
 * EMBEDDINGS_MODEL defaults to "text-embedding-3-small".
 */
// .trim() — `docker run --env-file` keeps trailing whitespace, which would
// corrupt the base URL / model name (see client.ts for the 404 this causes).
// Tag reflects the configured default (OPENAI_BASE_URL / api.openai.com) —
// override EMBEDDINGS_BASE_URL to point this at a different provider, and
// update the tag below to match, so ai_usage.provider stays truthful.
export const client = tagClientProvider(
  new OpenAI({
    apiKey: (process.env.EMBEDDINGS_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim(),
    baseURL: (process.env.EMBEDDINGS_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "").trim() || undefined,
  }),
  "openai",
);

const MODEL = (process.env.EMBEDDINGS_MODEL ?? "text-embedding-3-small").trim();

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
