import type OpenAI from "openai";
import { db } from "@repo/database";
import { aiUsage } from "@repo/database/models/ai-usage";
import { logger } from "@repo/logger";
import { currentAiUsage } from "./context.ts";
import { computeCost, PRICING_VERSION } from "./pricing.ts";
import { uuidv7 } from "./uuid7.ts";

// ── Client tagging ──────────────────────────────────────────────────────

const providerByClient = new WeakMap<object, string>();

/**
 * Wrap `new OpenAI(...)` so the wrappers below know which provider a client
 * talks to without sniffing its base URL. Each client in this package is
 * constructed exactly once, so tagging it here is one string per client, not
 * a URL-parsing branch that has to be kept in sync as providers are added.
 */
export function tagClientProvider<T extends object>(client: T, provider: string): T {
  providerByClient.set(client, provider);
  return client;
}

function providerOf(client: object): string {
  return providerByClient.get(client) ?? "unknown";
}

// ── Metadata ─────────────────────────────────────────────────────────────

/**
 * Extend this union with new literals as needed — never widen to `string`.
 * That single change is what would let `metadata.prompt = prompt` typecheck
 * and turn this accounting table into a shadow copy of user mail.
 */
export type UsageMetadataTag =
  | "map"
  | "reduce"
  | "batch"
  | "single"
  | "backfill"
  | "webhook"
  | "beautify"
  | "resume";

export type UsageMetadata = Record<string, number | boolean | UsageMetadataTag>;

export interface UsageMeta {
  /** Intrinsic to the call site. Never sourced from AsyncLocalStorage — see context.ts. */
  feature: string;
  metadata?: UsageMetadata;
}

// ── Provider request id ─────────────────────────────────────────────────

/**
 * Single point of contact with the SDK's (pseudo-private, underscored)
 * request-id field, so there is exactly one place to update if a future SDK
 * version changes how this is exposed. DeepSeek, OpenRouter, and the Gemini
 * compatibility endpoint don't all populate it — callers must treat the
 * result as optional.
 */
function extractProviderRequestId(response: unknown): string | undefined {
  const id = (response as { _request_id?: string | null } | undefined)?._request_id;
  return id ?? undefined;
}

// ── Recording ────────────────────────────────────────────────────────────

interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

interface RecordUsageInput {
  status: "ok" | "error";
  operation: "chat" | "chat_stream" | "embedding";
  provider: string;
  model: string;
  feature: string;
  userId?: string;
  requestId: string;
  durationMs: number;
  usage?: UsageLike;
  providerRequestId?: string;
  errorCode?: string;
  metadata?: UsageMetadata;
}

/**
 * Fire-and-forget by design (callers do `void recordUsage(...).catch(...)`):
 * a DB problem must never fail an AI request or add latency to a
 * user-facing response. See the module-level tradeoff note below.
 *
 * ACCEPTED TRADEOFF: a write that hasn't landed when the process dies
 * (deploy, container stop, crash) is lost forever. This table is a
 * near-complete record, not a ledger — never use SUM(cost_usd) as an
 * authoritative bill. The provider dashboard is the source of truth for the
 * total; this table explains the breakdown.
 *
 * Deliberately not batched/buffered: at current volumes (embedding batches
 * are 20 items in a single request, at concurrency 1) a buffer buys little
 * and *widens* the shutdown loss window above. Revisit if bulk indexing
 * volume grows enough that per-call inserts become the bottleneck.
 */
async function recordUsage(input: RecordUsageInput): Promise<void> {
  const promptTokens = input.status === "ok" ? (input.usage?.prompt_tokens ?? 0) : null;
  const cachedPromptTokens =
    input.status === "ok" ? (input.usage?.prompt_tokens_details?.cached_tokens ?? 0) : null;
  const completionTokens = input.status === "ok" ? (input.usage?.completion_tokens ?? 0) : null;
  const totalTokens =
    input.status === "ok"
      ? (input.usage?.total_tokens ?? (promptTokens ?? 0) + (completionTokens ?? 0))
      : null;

  const cost =
    input.status === "ok"
      ? computeCost(input.model, {
          promptTokens: promptTokens ?? 0,
          cachedPromptTokens: cachedPromptTokens ?? 0,
          completionTokens: completionTokens ?? 0,
        })
      : null;

  await db.insert(aiUsage).values({
    userId: input.userId ?? null,
    feature: input.feature,
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    promptTokens,
    cachedPromptTokens,
    completionTokens,
    totalTokens,
    inputPricePerMtok: cost?.inputPricePerMTok ?? null,
    cachedInputPricePerMtok: cost?.cachedInputPricePerMTok ?? null,
    outputPricePerMtok: cost?.outputPricePerMTok ?? null,
    costUsd: cost?.costUsd ?? null,
    pricingKnown: cost?.pricingKnown ?? false,
    pricingVersion: PRICING_VERSION,
    durationMs: input.durationMs,
    requestId: input.requestId,
    providerRequestId: input.providerRequestId ?? null,
    status: input.status,
    errorCode: input.errorCode ?? null,
    metadata: input.metadata ?? null,
  });
}

function swallow(context: string) {
  return (err: unknown) => {
    // A silently failing accounting table looks identical to an idle one —
    // always log the swallowed failure.
    logger.error(`[ai-usage] ${context}`, { error: err instanceof Error ? err.message : String(err) });
  };
}

function errorCodeOf(err: unknown): string {
  const e = err as { status?: number; code?: string; type?: string };
  return String(e?.status ?? e?.code ?? e?.type ?? "unknown");
}

/**
 * Logs, records, then rethrows the ORIGINAL error unmodified — every
 * existing caller's retry behavior depends on the error's identity (e.g.
 * packages/inngest/src/functions/email-priority.ts maps insufficient_quota
 * / 429 to specific Inngest error types). Never log prompt/message content —
 * same rule as UsageMetadata above.
 */
function handleFailure(
  err: unknown,
  ctx: { operation: RecordUsageInput["operation"]; provider: string; model: string; feature: string; userId?: string; requestId: string; durationMs: number; metadata?: UsageMetadata },
): never {
  const errorCode = errorCodeOf(err);
  logger.error("[ai-usage] request failed", {
    ...ctx,
    errorCode,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  void recordUsage({ ...ctx, status: "error", errorCode }).catch(swallow("failed to record error row"));
  throw err;
}

// ── Wrappers ─────────────────────────────────────────────────────────────

export async function chatCompletion(
  client: OpenAI,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  meta: UsageMeta,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const provider = providerOf(client);
  const ctx = currentAiUsage();
  const requestId = ctx?.requestId ?? uuidv7();
  const start = performance.now();

  try {
    const response = await client.chat.completions.create({ ...params, stream: false });
    const durationMs = Math.round(performance.now() - start);
    void recordUsage({
      status: "ok",
      operation: "chat",
      provider,
      model: params.model,
      feature: meta.feature,
      userId: ctx?.userId,
      requestId,
      durationMs,
      usage: response.usage,
      providerRequestId: extractProviderRequestId(response),
      metadata: meta.metadata,
    }).catch(swallow("failed to record chat usage"));
    return response;
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    handleFailure(err, {
      operation: "chat",
      provider,
      model: params.model,
      feature: meta.feature,
      userId: ctx?.userId,
      requestId,
      durationMs,
      metadata: meta.metadata,
    });
  }
}

/**
 * Separate implementation from chatCompletion, not a `stream: boolean` flag —
 * usage doesn't exist on the return value at all here; it arrives on the
 * final chunk, and only because `stream_options.include_usage` is forced on
 * below.
 *
 * Abandonment (the consumer stops iterating — e.g. `for await ... break`, or
 * an aborted HTTP response — before the stream finishes and before any
 * error is thrown) is detected via ordinary async-generator semantics: early
 * exit from a `for await` calls the generator's `.return()`, which runs this
 * generator's `finally` block. `record()` is idempotent (guarded by
 * `recorded`), so that `finally` only ever fires for the abandoned case —
 * the success and error paths already record before it runs.
 */
export async function* streamChatCompletion(
  client: OpenAI,
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  meta: UsageMeta,
): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk, void, unknown> {
  const provider = providerOf(client);
  const ctx = currentAiUsage();
  const requestId = ctx?.requestId ?? uuidv7();
  const start = performance.now();

  let usage: UsageLike | undefined;
  let providerRequestId: string | undefined;
  let recorded = false;

  const record = (status: "ok" | "error", errorCode?: string) => {
    if (recorded) return;
    recorded = true;
    const durationMs = Math.round(performance.now() - start);
    void recordUsage({
      status,
      operation: "chat_stream",
      provider,
      model: params.model,
      feature: meta.feature,
      userId: ctx?.userId,
      requestId,
      durationMs,
      usage,
      providerRequestId,
      errorCode,
      metadata: meta.metadata,
    }).catch(swallow("failed to record stream usage"));
  };

  try {
    const stream = await client.chat.completions.create({
      ...params,
      stream: true,
      stream_options: { include_usage: true },
    });
    providerRequestId = extractProviderRequestId(stream);

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      yield chunk;
    }
    record("ok");
  } catch (err) {
    const errorCode = errorCodeOf(err);
    logger.error("[ai-usage] request failed", {
      operation: "chat_stream",
      provider,
      model: params.model,
      feature: meta.feature,
      userId: ctx?.userId,
      requestId,
      errorCode,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    record("error", errorCode);
    throw err;
  } finally {
    // No-op unless the stream was abandoned before success/error recorded above.
    record("error", "stream_abandoned");
  }
}

export async function embeddingsCreate(
  client: OpenAI,
  params: OpenAI.Embeddings.EmbeddingCreateParams,
  meta: UsageMeta,
): Promise<OpenAI.Embeddings.CreateEmbeddingResponse> {
  const provider = providerOf(client);
  const ctx = currentAiUsage();
  const requestId = ctx?.requestId ?? uuidv7();
  const start = performance.now();
  const model = String(params.model);

  try {
    const response = await client.embeddings.create(params);
    const durationMs = Math.round(performance.now() - start);
    void recordUsage({
      status: "ok",
      operation: "embedding",
      provider,
      model,
      feature: meta.feature,
      userId: ctx?.userId,
      requestId,
      durationMs,
      // Embeddings have no completion tokens — 0, not NULL: it's a known
      // zero, not usage we failed to observe.
      usage: {
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        completion_tokens: 0,
        total_tokens: response.usage?.total_tokens ?? response.usage?.prompt_tokens ?? 0,
      },
      providerRequestId: extractProviderRequestId(response),
      metadata: meta.metadata,
    }).catch(swallow("failed to record embedding usage"));
    return response;
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    handleFailure(err, {
      operation: "embedding",
      provider,
      model,
      feature: meta.feature,
      userId: ctx?.userId,
      requestId,
      durationMs,
      metadata: meta.metadata,
    });
  }
}
