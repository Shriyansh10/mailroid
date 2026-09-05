/**
 * Per-mailbox in-flight request semaphore (P-5b + P-12,
 * docs/gmail-rate-limit-boundary.md §13).
 *
 * THE INVARIANT THIS ENFORCES IS NOT "every sync loop uses a semaphore." It
 * is: every Gmail call that can contribute to mailbox concurrency acquires
 * THE SAME per-mailbox semaphore. Replacing the hardcoded `mapWithConcurrency`
 * numbers at their call sites would satisfy the weaker statement and leave
 * any caller reaching Gmail by another route uncounted — which is exactly
 * how W-2 happened (§12.2). So acquisition lives at the TRANSPORT BOUNDARY —
 * gmail-request.ts for raw fetches, retry.ts's withGmailRetry for every
 * corsair `api.*` call — where no caller can bypass it, rather than at each
 * of the (currently four, and growing) `mapWithConcurrency` sites. See
 * docs/gmail-call-graph.md for the enumerated proof this actually covers
 * every call site, and the two explicit, justified exceptions.
 *
 * A per-call-site number bounds only that ONE loop's own fan-out. If two
 * loops each cap themselves at 4 and run concurrently against the same
 * mailbox — a UI click during a background sync, say — the real concurrency
 * is 8, not 4. Keying this semaphore the SAME way quota-limiter.ts keys its
 * buckets (mailbox preferred, tenantId fallback) is what makes "the same
 * mailbox" the unit of account rather than "the same tenant" or "the same
 * loop" — two tenants sharing one mailbox (§5's handover) share one ceiling,
 * for the identical B-3 reason the quota bucket does.
 *
 * FIFO queue, not a race for a shared counter: a waiter is a resolve function
 * pushed onto that mailbox's queue, popped and called by the release that
 * frees the slot it's waiting for. No caller can starve another indefinitely
 * — first in line always goes next, regardless of arrival order.
 *
 * SINGLE PROCESS ONLY, same limitation as quota-limiter.ts's bucket map and
 * for the identical reason — see that module's "SINGLE PROCESS ONLY" header.
 * One mailroid-api container today; a second replica gets its own map and
 * the real ceiling becomes N x this one.
 */

import { logger } from "@repo/logger";

/**
 * Sized well under Gmail's per-user concurrent-request limit (§3.1) — Google
 * does not publish an exact figure, so this is deliberately conservative
 * rather than a measured ceiling. It replaces the per-loop reservation-depth
 * reasoning `sync-metadata.ts` used to carry alone (4 in flight = 160 units
 * of schedule booked ahead) with one number that has to cover EVERY source
 * of Gmail traffic at once — a sync loop, a UI click, a webhook diff, a
 * draft save — not just one loop's own fan-out.
 */
const DEFAULT_MAILBOX_CONCURRENCY = 6;

function clampedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn("[GMAIL_SEMAPHORE] ignoring unparseable override", { name, raw, fallback });
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, parsed));
  if (clamped !== parsed) {
    logger.warn("[GMAIL_SEMAPHORE] override clamped", { name, requested: parsed, applied: clamped });
  }
  return clamped;
}

const MAILBOX_CONCURRENCY = clampedEnvInt(
  "GMAIL_MAILBOX_CONCURRENCY",
  DEFAULT_MAILBOX_CONCURRENCY,
  1,
  50,
);

interface MailboxSlot {
  inFlight: number;
  waiters: Array<() => void>;
}

const slots = new Map<string, MailboxSlot>();

/**
 * Same preference order as quota-limiter.ts's `bucketKey`, and for the same
 * reason: an unattributed call is bounded against a shared slot rather than
 * escaping the limit entirely.
 */
function semaphoreKey(req: { mailbox?: string; tenantId?: string }): string {
  return req.mailbox ?? req.tenantId ?? "unattributed";
}

function getSlot(key: string): MailboxSlot {
  let slot = slots.get(key);
  if (!slot) {
    slot = { inFlight: 0, waiters: [] };
    slots.set(key, slot);
  }
  return slot;
}

/**
 * Reserve one in-flight slot for this mailbox. Resolves immediately if under
 * the ceiling; otherwise queues FIFO behind whoever is already in flight.
 * Returns a release function — MUST be called exactly once, in a `finally`,
 * regardless of whether the call it guarded succeeded or threw.
 */
export async function acquireMailboxSlot(req: {
  mailbox?: string;
  tenantId?: string;
}): Promise<() => void> {
  const key = semaphoreKey(req);
  const slot = getSlot(key);

  if (slot.inFlight < MAILBOX_CONCURRENCY) {
    slot.inFlight += 1;
  } else {
    await new Promise<void>((resolve) => slot.waiters.push(resolve));
    // No increment here. release() (below) hands its slot DIRECTLY to the
    // next waiter without ever decrementing inFlight in between — the count
    // stays at the ceiling the whole time, correctly reflecting that the
    // slot never actually sat empty.
  }

  let released = false;
  return () => {
    if (released) return; // idempotent — a caller that awaits both branches must not double-release
    released = true;

    const next = slot.waiters.shift();
    if (next) {
      // Hand the slot directly to the next waiter rather than decrementing
      // and letting them re-acquire: that would race a THIRD caller for the
      // slot that just freed, breaking FIFO order.
      next();
    } else {
      slot.inFlight -= 1;
      // Empty, idle mailboxes must not accumulate map entries forever —
      // same "provably lossless" reasoning as quota-limiter.ts's bucket
      // reaping: a slot with zero in-flight and zero waiters is
      // indistinguishable from one that was never created.
      if (slot.inFlight === 0 && slot.waiters.length === 0) {
        slots.delete(key);
      }
    }
  };
}

export interface MailboxSemaphoreSnapshot {
  mailboxesInFlight: number;
  totalInFlight: number;
  totalWaiting: number;
  concurrencyLimit: number;
}

export function mailboxSemaphoreSnapshot(): MailboxSemaphoreSnapshot {
  let totalInFlight = 0;
  let totalWaiting = 0;
  for (const slot of slots.values()) {
    totalInFlight += slot.inFlight;
    totalWaiting += slot.waiters.length;
  }
  return {
    mailboxesInFlight: slots.size,
    totalInFlight,
    totalWaiting,
    concurrencyLimit: MAILBOX_CONCURRENCY,
  };
}

/** Test seam — the slot map is process-global. */
export function __resetMailboxSemaphore(): void {
  slots.clear();
}

/** Exposed so tests assert against the same number the module actually uses. */
export const __config = { concurrencyLimit: MAILBOX_CONCURRENCY } as const;
