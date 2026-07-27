import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Identity only — deliberately no `feature` here. `feature` is intrinsic to
 * each call site and is passed directly to chatCompletion/streamChatCompletion
 * /embeddingsCreate, so there is no way for an ALS value and a wrapper value
 * to disagree. See track.ts.
 */
export interface AiUsageContext {
  userId?: string;
  requestId?: string;
}

const storage = new AsyncLocalStorage<AiUsageContext>();

/**
 * Wrap an entry point (an API route handler, an Inngest step body, a
 * per-user unit of background work) so every AI call underneath it — no
 * matter how deep, and without threading userId through every function
 * signature — is attributed to `ctx`.
 */
export function withAiUsage<T>(ctx: AiUsageContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentAiUsage(): AiUsageContext | undefined {
  return storage.getStore();
}
