import { pgTable, uuid, text, integer, numeric, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/**
 * One row per AI provider call — chat, streaming chat, or embeddings —
 * successful or failed. Written by packages/ai/src/usage/track.ts.
 *
 * This is a near-complete record, not a ledger: writes are fire-and-forget
 * (see track.ts), so a row can be lost if the process dies before the insert
 * lands. Do not use SUM(cost_usd) as an authoritative bill — the provider
 * dashboard is the source of truth for the total; this table explains the
 * breakdown.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // Cost history must survive a user being deleted.
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),

    feature: text("feature").notNull(),
    operation: text("operation").notNull(), // "chat" | "chat_stream" | "embedding"
    provider: text("provider").notNull(),
    model: text("model").notNull(),

    // 0 when legitimately zero (e.g. embeddings have no completion tokens).
    // NULL only when unknown because the request failed before usage came back.
    promptTokens: integer("prompt_tokens"),
    cachedPromptTokens: integer("cached_prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),

    inputPricePerMtok: numeric("input_price_per_mtok", { precision: 20, scale: 10 }),
    cachedInputPricePerMtok: numeric("cached_input_price_per_mtok", { precision: 20, scale: 10 }),
    outputPricePerMtok: numeric("output_price_per_mtok", { precision: 20, scale: 10 }),
    costUsd: numeric("cost_usd", { precision: 20, scale: 10 }),
    pricingKnown: boolean("pricing_known").notNull(),
    pricingVersion: text("pricing_version").notNull(),

    durationMs: integer("duration_ms").notNull(),

    // Mailroid's own correlation id (UUIDv7) — ties together every call one
    // logical operation makes (an agent-loop turn, a summarize map/reduce run).
    requestId: text("request_id").notNull(),
    providerRequestId: text("provider_request_id"),

    status: text("status").notNull(), // "ok" | "error"
    errorCode: text("error_code"),

    // Small debugging context only — counts, ids, versions, flags, and a
    // closed set of literal tags (see UsageMetadata in usage/track.ts).
    // NEVER prompt text, email content, or any other PII: this table is read
    // by an operator CLI and must not become a shadow copy of user mail.
    metadata: jsonb("metadata"),
  },
  (table) => [
    index("ai_usage_created_at_idx").on(table.createdAt),
    index("ai_usage_user_created_idx").on(table.userId, table.createdAt),
    index("ai_usage_feature_created_idx").on(table.feature, table.createdAt),
    index("ai_usage_model_created_idx").on(table.model, table.createdAt),
  ],
);
