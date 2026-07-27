import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCost } from "./pricing.ts";

test("computeCost: known model, no cache", () => {
  const result = computeCost("gpt-4o-mini", {
    promptTokens: 1_000_000,
    cachedPromptTokens: 0,
    completionTokens: 1_000_000,
  });
  assert.equal(result.pricingKnown, true);
  assert.equal(result.costUsd, (0.15 + 0.6).toFixed(10));
});

test("computeCost: cached tokens priced at the cached rate, not the input rate", () => {
  const result = computeCost("gpt-4o-mini", {
    promptTokens: 1_000_000,
    cachedPromptTokens: 1_000_000,
    completionTokens: 0,
  });
  assert.equal(result.pricingKnown, true);
  // All prompt tokens were cache hits, so this should be the cached rate,
  // not the (higher) uncached input rate.
  assert.equal(result.costUsd, (0.075).toFixed(10));
});

test("computeCost: mixed cached and uncached prompt tokens split correctly", () => {
  const result = computeCost("gpt-4o-mini", {
    promptTokens: 1_000_000,
    cachedPromptTokens: 400_000,
    completionTokens: 0,
  });
  const expected = (600_000 / 1_000_000) * 0.15 + (400_000 / 1_000_000) * 0.075;
  assert.equal(result.costUsd, expected.toFixed(10));
});

test("computeCost: unknown model falls back to zero cost and pricingKnown=false", () => {
  const result = computeCost("some-future-model-nobody-priced-yet", {
    promptTokens: 1_000,
    cachedPromptTokens: 0,
    completionTokens: 1_000,
  });
  assert.equal(result.pricingKnown, false);
  assert.equal(result.costUsd, (0).toFixed(10));
});

test("computeCost: zero tokens is zero cost for a known model", () => {
  const result = computeCost("deepseek-chat", {
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
  });
  assert.equal(result.pricingKnown, true);
  assert.equal(result.costUsd, (0).toFixed(10));
});
