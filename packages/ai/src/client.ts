import OpenAI from "openai";
import "dotenv/config";

/**
 * DeepSeek chat client.
 *
 * DeepSeek exposes an OpenAI-compatible API at https://api.deepseek.com/v1.
 * We reuse the `openai` SDK (already a dependency) — no new packages needed.
 *
 * Environment variables:
 *   DEEPSEEK_API_KEY    — required
 *   DEEPSEEK_BASE_URL   — defaults to https://api.deepseek.com/v1
 *   DEEPSEEK_CHAT_MODEL — defaults to "deepseek-chat"
 */

// .trim() these because `docker run --env-file` preserves trailing whitespace
// literally (unlike dotenv). A stray space on DEEPSEEK_BASE_URL builds a
// malformed request URL (".../v1  /chat/completions") → 404 (no body); a space
// on the model name → model-not-found. Trimming makes env parsing whitespace-safe.
const DEEPSEEK_BASE_URL =
  (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1").trim();

const DEEPSEEK_CHAT_MODEL =
  (process.env.DEEPSEEK_CHAT_MODEL ?? "deepseek-chat").trim();

// gpt-4o-mini's real context window — this deployment's DEEPSEEK_CHAT_MODEL
// is actually set to "gpt-4o-mini" against DEEPSEEK_BASE_URL=api.openai.com,
// despite the DeepSeek-branded env var names. Powers the assistant UI's
// context-usage indicator. Update this if DEEPSEEK_CHAT_MODEL is ever
// pointed at a different model with a different window size.
export const MODEL_CONTEXT_WINDOW_TOKENS = 128_000;

export const deepseek = new OpenAI({
  apiKey: (process.env.DEEPSEEK_API_KEY ?? "").trim(),
  baseURL: DEEPSEEK_BASE_URL,
});

export { DEEPSEEK_CHAT_MODEL, DEEPSEEK_BASE_URL };
