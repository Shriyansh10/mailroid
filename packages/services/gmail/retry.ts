import { logger } from "@repo/logger";

/**
 * Retries a Gmail API call on transient failures (429 rate limit, 5xx,
 * network errors) with exponential backoff + jitter. Gmail's 429 responses
 * don't reliably include Retry-After, so this uses a fixed backoff schedule
 * instead of trusting response headers.
 */
export async function withGmailRetry<T>(
  label: string,
  fn: () => Promise<T>,
  { retries = 4, baseDelayMs = 500 }: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number; code?: number })?.status
        ?? (err as { code?: number })?.code;
      const retryable = status === 429 || (typeof status === "number" && status >= 500) || !status;
      if (!retryable || attempt === retries) break;

      const delay = baseDelayMs * 2 ** attempt + Math.random() * 250;
      logger.warn("[GMAIL] transient failure, retrying", {
        label, attempt: attempt + 1, retries, delayMs: Math.round(delay), status,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
