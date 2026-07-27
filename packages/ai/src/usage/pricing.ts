import { logger } from "@repo/logger";

/**
 * Bump whenever MODEL_PRICING changes. Stored on every ai_usage row alongside
 * the unit prices actually used, so a later edit to this file can never
 * rewrite what an old row says it cost — see ai-usage.ts's doc comment.
 */
export const PRICING_VERSION = "2026-07-27";

export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 cached input tokens (usage.prompt_tokens_details.cached_tokens). */
  cachedInputPerMTok: number;
  /** USD per 1,000,000 output tokens. 0 for embedding models. */
  outputPerMTok: number;
}

/**
 * Keyed by the exact model string sent to the provider (DEEPSEEK_CHAT_MODEL,
 * EMBEDDINGS_MODEL, etc.), not a display name.
 *
 * These figures are a starting point — verify against the provider's current
 * pricing page before relying on cost totals for anything financial, and
 * bump PRICING_VERSION when you change them.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  "deepseek-chat": { inputPerMTok: 0.27, cachedInputPerMTok: 0.07, outputPerMTok: 1.1 },
  "gpt-4o-mini": { inputPerMTok: 0.15, cachedInputPerMTok: 0.075, outputPerMTok: 0.6 },
  "text-embedding-3-small": { inputPerMTok: 0.02, cachedInputPerMTok: 0.02, outputPerMTok: 0 },
  "text-embedding-3-large": { inputPerMTok: 0.13, cachedInputPerMTok: 0.13, outputPerMTok: 0 },
};

export interface TokenCounts {
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
}

export interface CostResult {
  inputPricePerMTok: string;
  cachedInputPricePerMTok: string;
  outputPricePerMTok: string;
  costUsd: string;
  pricingKnown: boolean;
}

const warnedUnknownModels = new Set<string>();

function warnUnknownModelOnce(model: string): void {
  if (warnedUnknownModels.has(model)) return;
  warnedUnknownModels.add(model);
  logger.error("[ai-usage] no pricing entry for model — costs will record as $0", { model });
}

const toFixed10 = (n: number) => n.toFixed(10);

/**
 * Pure — no DB, no I/O (besides the one-time unknown-model warning). Kept
 * separate from recordUsage() specifically so rounding, the cached-token
 * split, and the unknown-model fallback can be unit tested without a
 * database in the loop. See pricing.test.ts.
 */
export function computeCost(model: string, tokens: TokenCounts): CostResult {
  const price = MODEL_PRICING[model];

  if (!price) {
    warnUnknownModelOnce(model);
    return {
      inputPricePerMTok: toFixed10(0),
      cachedInputPricePerMTok: toFixed10(0),
      outputPricePerMTok: toFixed10(0),
      costUsd: toFixed10(0),
      pricingKnown: false,
    };
  }

  const billableInputTokens = Math.max(0, tokens.promptTokens - tokens.cachedPromptTokens);
  const cost =
    (billableInputTokens / 1_000_000) * price.inputPerMTok +
    (tokens.cachedPromptTokens / 1_000_000) * price.cachedInputPerMTok +
    (tokens.completionTokens / 1_000_000) * price.outputPerMTok;

  return {
    inputPricePerMTok: toFixed10(price.inputPerMTok),
    cachedInputPricePerMTok: toFixed10(price.cachedInputPerMTok),
    outputPricePerMTok: toFixed10(price.outputPerMTok),
    costUsd: toFixed10(cost),
    pricingKnown: true,
  };
}
