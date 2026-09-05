/**
 * Loud, countable — not a `warn` that scrolls past (P-2,
 * docs/gmail-rate-limit-boundary.md §13).
 *
 * A Gmail Pub/Sub push for a mailbox this process cannot resolve to a tenant
 * is exactly what an orphaned/stolen watch looks like from here — §9.2's two
 * mailboxes did this for 14+ hours with nothing counting it. A single log
 * line per delivery is invisible against normal traffic and rotates away;
 * this in-process counter is read by /api/_debug/watch-health so "how many,
 * since when" is a query instead of a grep across rotated log files.
 *
 * Process-local by design, like the quota limiter's own bucket map — see its
 * header. Resets on restart, which is fine: this is a live-incident signal,
 * not a durable audit trail. If it needs to survive a restart, it needs a
 * database column, not a bigger counter.
 */

let count = 0;
let firstAt: Date | null = null;
let lastAt: Date | null = null;

export function recordUnmappedPush(): void {
  count += 1;
  const now = new Date();
  if (!firstAt) firstAt = now;
  lastAt = now;
}

export interface UnmappedPushSnapshot {
  count: number;
  firstAt: string | null;
  lastAt: string | null;
}

export function unmappedPushSnapshot(): UnmappedPushSnapshot {
  return {
    count,
    firstAt: firstAt?.toISOString() ?? null,
    lastAt: lastAt?.toISOString() ?? null,
  };
}

/** Test seam. */
export function __resetUnmappedPushCounter(): void {
  count = 0;
  firstAt = null;
  lastAt = null;
}
