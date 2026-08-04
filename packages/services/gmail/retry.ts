import { logger } from "@repo/logger";

import {
  assertNotCoolingDown,
  isQuotaError,
  markGmailHealthy,
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
 * webhook or the cooldown-resume cron. 5xx and transport errors are genuinely
 * transient and keep the exponential backoff.
 *
 * Pass `tenantId` wherever it's known: it enables the pre-flight check that
 * skips the call entirely while a mailbox is cooling down, and the success
 * path that resets the escalation counter (markGmailHealthy) once Gmail
 * actually answers again.
 */

/**
 * `label` is `"<operation> <targetId>"` by convention (e.g.
 * `"threads.get 19fc9552b8292ff4"`), or just `"<operation>"` when there's no
 * single target (e.g. `"syncHistoryForTenant"`). Split once so cooldown logs
 * carry structured `operation`/`targetId` fields instead of one opaque string.
 */
function parseLabel(label: string): { operation: string; targetId?: string } {
  const spaceIdx = label.indexOf(" ");
  if (spaceIdx === -1) return { operation: label };
  return { operation: label.slice(0, spaceIdx), targetId: label.slice(spaceIdx + 1) };
}

export async function withGmailRetry<T>(
  label: string,
  fn: () => Promise<T>,
  {
    retries = 4,
    baseDelayMs = 500,
    tenantId,
    trigger = "unknown",
    hooks,
  }: {
    retries?: number;
    baseDelayMs?: number;
    tenantId?: string;
    /** What caused this call: "ui" | "sync" | "webhook" | "resume-cron" | ... */
    trigger?: string;
    /** Test seam: lets a future retry.test.ts run without a database. */
    hooks?: {
      assertNotCoolingDown?: typeof assertNotCoolingDown;
      recordQuotaError?: typeof recordQuotaError;
      markGmailHealthy?: typeof markGmailHealthy;
    };
  } = {},
): Promise<T> {
  const assertFn = hooks?.assertNotCoolingDown ?? assertNotCoolingDown;
  const recordFn = hooks?.recordQuotaError ?? recordQuotaError;
  const healthyFn = hooks?.markGmailHealthy ?? markGmailHealthy;
  const { operation, targetId } = parseLabel(label);
  const ctx = { trigger, operation, targetId };

  // Cheapest possible win: don't spend a call we already know will be refused
  // and would extend the penalty window.
  if (tenantId) await assertFn(tenantId, ctx);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn();

      // Awaited, not fire-and-forget — the write is rare (memo-gated inside
      // markGmailHealthy) so the latency lands only on an actual recovery,
      // and a failure here must never fail a Gmail call that just succeeded.
      if (tenantId) {
        await healthyFn(tenantId, { ...ctx, recoveredBy: "live-call-succeeded" }).catch(
          (err) => {
            logger.error("[GMAIL] markGmailHealthy failed after successful call", {
              tenantId, label, error: String(err),
            });
          },
        );
      }

      return result;
    } catch (err) {
      lastErr = err;

      if (isQuotaError(err)) {
        if (tenantId) await recordFn(tenantId, err, ctx).catch(() => {});
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
