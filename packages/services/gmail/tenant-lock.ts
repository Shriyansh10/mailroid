import { logger } from "@repo/logger";

/**
 * Per-tenant single-flight for webhook diffs.
 *
 * NOT A LOCK — named accurately on purpose. It coalesces concurrent work for
 * the same key inside ONE Node process, and provides no mutual exclusion
 * across processes.
 *
 * What it is for: the legacy webhook path fires
 * `void syncHistoryForTenant(...)` per delivery with nothing serialising it.
 * The `concurrency = 2` inside ingestAllOrThrow is per-delivery, so as its own
 * comment says, "the real ceiling is this number times the number of concurrent
 * deliveries" — N overlapping notifications for one mailbox means 2N
 * simultaneous Gmail calls, a good way to trip a per-user rate limit.
 *
 * Scope, stated plainly because it will matter later:
 *
 *   The DB cooldown protects CORRECTNESS.
 *   This single-flight only reduces DUPLICATE WORK.
 *
 * That asymmetry is why this implementation stays deliberately simple. A rare
 * interleaving that lets two runs overlap costs one redundant diff — and a
 * redundant diff is harmless, because the cursor hasn't moved and ingestMessage
 * upserts. Cleverness here would buy nothing and risk the one failure that
 * would actually hurt: an entry stranded in the map, wedging a mailbox forever.
 *
 * Production runs a single mailroid-api container (see
 * .github/workflows/mailroid-deploy.yml), so today this covers every delivery.
 * At two or more containers each gets its own Map and coalescing degrades —
 * but nothing breaks. If you scale out and want it back, use a Postgres
 * advisory lock (`pg_try_advisory_lock(hashtext(tenantId))`) or move to the
 * Inngest path, whose `{ key: "event.data.tenantId", limit: 1 }` is the real
 * distributed guarantee.
 */

interface Entry {
  running: Promise<unknown>;
  /** At most one delivery may wait — see the queue-depth note below. */
  hasWaiter: boolean;
}

const inFlight = new Map<string, Entry>();

/**
 * Returns `undefined` when the call was dropped as redundant, otherwise the
 * result of `fn`.
 */
export async function withTenantSingleFlight<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const existing = inFlight.get(key);

  if (existing) {
    // QUEUE DEPTH IS 1, DELIBERATELY — not a tuning knob.
    //
    // Every queued delivery for a tenant replays from the same un-advanced
    // cursor, so they would do byte-identical work. One waiter is provably
    // sufficient: when it runs it fetches the diff from whatever the cursor is
    // at that moment, which already covers everything the deliveries dropped
    // behind it would have found. Anything past the first waiter is pure
    // duplication, and dropping it is safe for exactly the same reason.
    if (existing.hasWaiter) {
      logger.info("[GMAIL] single-flight: dropped redundant delivery", { key });
      return undefined;
    }

    existing.hasWaiter = true;
    // A predecessor's failure is its own caller's problem, not ours — but we
    // must still wait for it to finish before starting.
    await existing.running.catch(() => {});
  }

  const running = fn();
  inFlight.set(key, { running, hasWaiter: false });

  try {
    return await running;
  } finally {
    // ALWAYS in finally, and only if we're still the current entry. A rejected
    // promise left behind would wedge that mailbox permanently — a deadlock
    // strictly worse than the concurrency this exists to bound.
    if (inFlight.get(key)?.running === running) inFlight.delete(key);
  }
}

/** Test seam — the map is module-global and would leak between cases. */
export function __resetSingleFlight(): void {
  inFlight.clear();
}
