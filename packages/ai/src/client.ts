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

const DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1";

const DEEPSEEK_CHAT_MODEL =
  process.env.DEEPSEEK_CHAT_MODEL ?? "deepseek-chat";

export const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseURL: DEEPSEEK_BASE_URL,
});

export { DEEPSEEK_CHAT_MODEL, DEEPSEEK_BASE_URL };
