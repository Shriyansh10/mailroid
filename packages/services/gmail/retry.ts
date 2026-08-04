import { logger } from "@repo/logger";

import {
  assertNotCoolingDown,
  isQuotaError,
  recordQuotaError,
} from "./quota-cooldown.ts";

/**
 * Retries a Gmail API call on transient failures with exponential backoff.
 *
 * A 429 IS NOT RETRIED HERE, and that is the point — please don't "fix" it.
 *
 * Gmail's per-user rate limit is not a bucket that refills while you wait: it
 * answers with an absolute instant ("Retry after 2026-08-04T03:58:23Z") and
 * every request made before that instant moves it FURTHER OUT. Retrying inside
 * the window is what keeps it open. Production evidence: 03:58:23 → 03:58:33 →
 * 03:58:43, one bump per retry, until the mailbox had been unusable for seven
 * hours. The old comment here claimed Gmail's Retry-After was untrustworthy and
 * backed off blindly — it was the timestamp in the message body all along, and
 * the blind backoff was feeding the problem.
 *
 * So a 429 records a cooldown (quota-cooldown.ts) and throws immediately. The
 * retry happens later, once the window has actually passed, driven by the next
 * webhook or the reconciliation sweep. 5xx and transport errors are genuinely
 * transient and keep the exponential backoff.
 *
 * Pass `tenantId` wherever it's known: it enables the pre-flight check that
 * skips the call entirely while a mailbox is cooling down.
 */
export async function withGmailRetry<T>(
  label: string,
  fn: () => Promise<T>,
  {
    retries = 4,
    baseDelayMs = 500,
    tenantId,
    hooks,
  }: {
    retries?: number;
    baseDelayMs?: number;
    tenantId?: string;
    /** Test seam: lets retry.test.ts run without a database. */
    hooks?: {
      assertNotCoolingDown?: (tenantId: string, label?: string) => Promise<void>;
      recordQuotaError?: (tenantId: string, err: unknown) => Promise<unknown>;
    };
  } = {},
): Promise<T> {
  const assertFn = hooks?.assertNotCoolingDown ?? assertNotCoolingDown;
  const recordFn = hooks?.recordQuotaError ?? recordQuotaError;

  // Cheapest possible win: don't spend a call we already know will be refused
  // and would extend the penalty window.
  if (tenantId) await assertFn(tenantId, label);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (isQuotaError(err)) {
        if (tenantId) await recordFn(tenantId, err).catch(() => {});
        logger.warn("[GMAIL] rate limited — not retrying, cooling down instead", {
          label,
          tenantId,
          attempt: attempt + 1,
        });
        break;
      }

      const status =
        (err as { status?: number; code?: number })?.status ??
        (err as { code?: number })?.code;
      const retryable = (typeof status === "number" && status >= 500) || !status;
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
