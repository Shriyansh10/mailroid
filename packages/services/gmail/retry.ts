import { logger } from "@repo/logger";

import {
  assertSyncAllowed,
  handleGmailFailure,
  markGmailHealthy,
} from "./quota-cooldown.ts";
import { GmailPacedOutError, classifyGmailFailure } from "./gmail-errors.ts";
import { quotaUnitsFor, quotaUnitsForPacing, recordGmailCall } from "./call-ledger.ts";
import { acquireQuota } from "./quota-limiter.ts";

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
 *
 * THIS IS ALSO THE QUOTA PACING CHOKE POINT for every corsair `api.*` call.
 * The order through here is fixed and each step earns its position:
 *
 *   1. gates      — refuse a paused/cooling mailbox instantly and for free
 *   2. pacing     — reserve quota, possibly waiting (quota-limiter.ts)
 *   3. the call   — and a fresh reservation before every retry
 *
 * Reversing 1 and 2 would make callers sleep before being told the mailbox was
 * unavailable anyway. Skipping the per-retry reservation would let a retry storm
 * spend several times what was admitted.
 *
 * A 429 is still not retried; pacing exists to stop us reaching one, not to
 * recover from one. The cooldown ladder remains the backstop — the limiter is
 * per-process and per-user and cannot see project-level quota at all.
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
    correlationId,
    hooks,
  }: {
    retries?: number;
    baseDelayMs?: number;
    tenantId?: string;
    /** What caused this call: "ui" | "sync" | "webhook" | "resume-cron" | ... */
    trigger?: string;
    /**
     * One user action or one background job, threaded from the entry point.
     * Reuses the `requestId` that several service paths already generate —
     * a parallel identifier would mean two ids naming the same thing and
     * neither joining to the other.
     */
    correlationId?: string;
    /** Test seam: lets retry.test.ts run without a database or a real clock. */
    hooks?: {
      assertSyncAllowed?: typeof assertSyncAllowed;
      handleGmailFailure?: typeof handleGmailFailure;
      markGmailHealthy?: typeof markGmailHealthy;
      acquireQuota?: typeof acquireQuota;
      recordGmailCall?: typeof recordGmailCall;
      now?: () => number;
    };
  } = {},
): Promise<T> {
  const assertFn = hooks?.assertSyncAllowed ?? assertSyncAllowed;
  const failureFn = hooks?.handleGmailFailure ?? handleGmailFailure;
  const healthyFn = hooks?.markGmailHealthy ?? markGmailHealthy;
  const acquireFn = hooks?.acquireQuota ?? acquireQuota;
  const recordFn = hooks?.recordGmailCall ?? recordGmailCall;
  const nowFn = hooks?.now ?? Date.now;
  const { operation, targetId } = parseLabel(label);
  const ctx = { trigger, operation, targetId };

  // The label's operation half is the price tag now, not just a log field —
  // `quotaUnitsForPacing` never returns undefined, and warns once for anything
  // it had to invent a price for.
  const units = quotaUnitsForPacing(operation);
  const fallbackPriced = quotaUnitsFor(operation) === undefined;

  /**
   * Time spent NOT talking to Google — pacing waits plus retry backoff.
   *
   * Subtracted from `durationMs` at both recording sites. The backoff sleeps
   * were always counted as Gmail latency, which quietly overstated the exact
   * figure the ledger exists to measure; making the pacing wait explicit is the
   * moment to fix that too rather than add a second distortion beside it.
   */
  let nonNetworkMs = 0;
  let pacedWaitMs = 0;

  async function reserve(): Promise<number> {
    const { waitedMs } = await acquireFn({
      tenantId,
      operation,
      trigger,
      correlationId,
      units,
      fallbackPriced,
    });
    pacedWaitMs += waitedMs;
    return waitedMs;
  }

  // Cheapest possible win: don't spend a call we already know will be refused
  // (operator pause, or a quota window we would only push further out).
  //
  // Deliberately BEFORE the ledger's timing starts and outside its accounting:
  // a call refused here never reached the network, and recording it as a Gmail
  // call would inflate exactly the egress figure the ledger exists to measure.
  if (tenantId) await assertFn(tenantId, ctx);

  // PACING COMES AFTER THE GATES, NEVER BEFORE. A mailbox in a 60-minute
  // cooldown must be refused instantly and for free; making the caller sleep two
  // seconds first, then telling it the mailbox is unavailable anyway, wastes the
  // wait and burns a schedule slot on a call that is never made.
  //
  // Also before `startedAt`, so this first wait falls outside `durationMs`
  // without any arithmetic. A GmailPacedOutError thrown here propagates before
  // the ledger's timing begins — deliberately unrecorded, for the same reason
  // the gate above is: a call refused before the network is not a Gmail call,
  // and booking it would inflate the egress figure being measured.
  await reserve();

  const startedAt = nowFn();
  // What actually goes to Google, as distinct from this one logical call. The
  // difference between them is the retry amplification signal (H-C).
  let networkAttempts = 0;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      networkAttempts++;
      const result = await fn();

      recordFn({
        tenantId,
        operation,
        trigger,
        correlationId,
        ok: true,
        attempts: networkAttempts,
        durationMs: nowFn() - startedAt - nonNetworkMs,
        waitedMs: pacedWaitMs || undefined,
      });

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

      // Quota and auth both stop the retry loop, for different reasons:
      // retrying a 429 pushes Google's window further out (see above), and
      // retrying a 401 just fails four more times against dead credentials.
      // Neither is transient. handleGmailFailure decides which state to write
      // — this code no longer classifies, so it cannot classify wrongly.
      const kind = classifyGmailFailure(err);
      if (kind !== "other") {
        if (tenantId) await failureFn(tenantId, err, ctx).catch(() => {});
        logger.warn(
          kind === "quota"
            ? "[GMAIL] rate limited — not retrying, cooling down instead"
            : "[GMAIL] authentication failed — not retrying",
          { label, tenantId, attempt: attempt + 1 },
        );
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
      nonNetworkMs += delay;

      // A retry is a SECOND REAL GMAIL CALL and costs units again. Reserving
      // only once would let a 4-retry storm spend 5x what the limiter admitted,
      // which is precisely the amplification the ledger's attempts/calls pair
      // exists to expose.
      try {
        nonNetworkMs += await reserve();
      } catch (pacingErr) {
        if (pacingErr instanceof GmailPacedOutError) {
          // SURFACE THE ORIGINAL FAILURE, not the pacing refusal. The caller
          // needs to know Gmail returned a 502; replacing that with "we declined
          // to schedule the retry" throws away the actual cause and would send
          // whoever reads the log looking at the limiter instead of at Google.
          logger.warn("[GMAIL] retry not scheduled — pacing cap reached", {
            label, tenantId, attempt: attempt + 1, waitMs: pacingErr.waitMs,
          });
          break;
        }
        throw pacingErr;
      }
    }
  }

  recordFn({
    tenantId,
    operation,
    trigger,
    correlationId,
    ok: false,
    attempts: networkAttempts,
    durationMs: nowFn() - startedAt - nonNetworkMs,
    waitedMs: pacedWaitMs || undefined,
  });

  throw lastErr;
}
