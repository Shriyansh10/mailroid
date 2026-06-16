import OpenAI from "openai";
import 'dotenv/config';

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
const client = new OpenAI({
  apiKey: process.env.EMBEDDINGS_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  baseURL: process.env.EMBEDDINGS_BASE_URL ?? process.env.OPENAI_BASE_URL ?? undefined,
});

const MODEL = process.env.EMBEDDINGS_MODEL ?? "text-embedding-3-small";

/**
 * Generate an embedding vector for a single text string.
 *
 * @param text - The text to embed (subject + body combined)
 * @returns number[] - 1536-dimensional embedding vector
 */
export async function createEmbedding(text: string): Promise<number[]> {
  const response = await client.embeddings.create({
    model: MODEL,
    input: text,
  });

  return response.data[0]!.embedding;
}

/**
 * Generate embeddings for multiple texts in a single API call.
 * Much more efficient than calling createEmbedding one at a time.
 *
 * @param texts - Array of text strings to embed
 * @returns Array of embedding vectors (same order as input)
 */
export async function createEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  const response = await client.embeddings.create({
    model: MODEL,
    input: texts,
  });

  return response.data.map((d) => d.embedding);
}
