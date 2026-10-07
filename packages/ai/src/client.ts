import OpenAI from "openai";
import "dotenv/config";
import { tagClientProvider } from "./usage/track.ts";

/**
 * The chat completion client.
 *
 * Deliberately provider-agnostic: nothing in this file, or anywhere that
 * imports it, names a vendor. Every provider-specific fact — who we talk to,
 * at what URL, with which model, and how big that model's context window is —
 * is configuration, not code. Swapping provider or model is an `.env` change
 * and a restart; no source file, comment or log line should have to be edited
 * to keep telling the truth afterwards.
 *
 * The client speaks the OpenAI wire format, which is the de-facto standard
 * that most providers expose. That is a protocol choice, not a vendor choice.
 *
 * Environment variables (all required — there are no defaults on purpose,
 * because a default here is a vendor hardcoded in code):
 *
 *   AI_PROVIDER    — short label recorded in `ai_usage.provider`, e.g. the
 *                    provider's name. Identifies which bill a call draws from.
 *   AI_API_KEY     — credential for that provider.
 *   AI_BASE_URL    — OpenAI-compatible endpoint, including the version path.
 *   AI_CHAT_MODEL  — exact model id sent on every request. Must appear in
 *                    MODEL_PRICING (usage/pricing.ts) or cost tracking
 *                    degrades to pricing_known=false.
 *   AI_CONTEXT_WINDOW_TOKENS — that model's real context window, used by the
 *                    assistant UI's context-usage indicator.
 */

// .trim() these because `docker run --env-file` preserves trailing whitespace
// literally (unlike dotenv). A stray space on the base URL builds a malformed
// request URL (".../v1  /chat/completions") → 404 with no body; a space on the
// model name → model-not-found. Trimming makes env parsing whitespace-safe.
const AI_PROVIDER = (process.env.AI_PROVIDER ?? "").trim();

const AI_BASE_URL = (process.env.AI_BASE_URL ?? "").trim();

const AI_CHAT_MODEL = (process.env.AI_CHAT_MODEL ?? "").trim();

/**
 * The configured model's context window, in tokens. Config rather than a
 * constant for the same reason the model id is: a hardcoded window silently
 * becomes a lie the moment AI_CHAT_MODEL changes, and the assistant's
 * context-usage indicator then reports a percentage of the wrong number.
 *
 * Falls back to 0, which the UI reads as "unknown" and hides the indicator —
 * an absent gauge is honest, a confidently wrong one is not.
 */
export const MODEL_CONTEXT_WINDOW_TOKENS = Number(
  process.env.AI_CONTEXT_WINDOW_TOKENS ?? 0,
);

// Surfaced loudly rather than left to fail as an opaque 401/404 from the
// provider three layers down. Not a throw: apps/web constructs this at module
// scope during `next build`, where no real credentials exist (Dockerfile.web
// supplies placeholders for exactly this reason).
for (const [name, value] of [
  ["AI_PROVIDER", AI_PROVIDER],
  ["AI_API_KEY", process.env.AI_API_KEY],
  ["AI_BASE_URL", AI_BASE_URL],
  ["AI_CHAT_MODEL", AI_CHAT_MODEL],
] as const) {
  if (!value || !String(value).trim()) {
    console.error(
      `[ai:config] ${name} is not set — AI features will fail until it is. ` +
        `See packages/ai/src/client.ts for the full list.`,
    );
  }
}

/**
 * Tagged with AI_PROVIDER so `ai_usage.provider` always reports whoever is
 * actually being billed. It used to be a hardcoded string, which drifted the
 * first time the base URL was repointed and left months of usage rows
 * attributed to a provider that had never served a single request.
 */
export const aiClient = tagClientProvider(
  new OpenAI({
    apiKey: (process.env.AI_API_KEY ?? "").trim(),
    baseURL: AI_BASE_URL || undefined,
  }),
  AI_PROVIDER || "unconfigured",
);

export { AI_CHAT_MODEL, AI_BASE_URL, AI_PROVIDER };
