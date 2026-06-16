import { createEmbedding } from "./generate.ts";

/**
 * Generate an embedding vector for a search query.
 * Normalizes the query text before embedding for better semantic matching.
 *
 * Strips common filler prefixes like "find emails about", "search for", etc.
 * leaving the core meaning-bearing terms.
 *
 * @param query - The user's natural language search query
 * @returns Promise<number[]> - 1536-dimensional embedding vector
 */
export async function embedSearchQuery(query: string): Promise<number[]> {
  // Strip filler prefixes — keep the core semantic content
  const normalized = query
    .replace(
      /^(find|search|show|get|list|emails?|messages?|threads?|where|that|about|for|related\s+to)\s+/gi,
      "",
    )
    .trim();

  // Use normalized text if non-empty, fall back to original
  return createEmbedding(normalized || query);
}
