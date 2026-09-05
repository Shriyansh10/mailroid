/**
 * tenantId -> mailbox address, cached (P-5a, docs/gmail-rate-limit-boundary.md
 * §13).
 *
 * WHY THIS EXISTS, SEPARATE FROM quota-limiter.ts. The limiter re-keys its
 * buckets on the mailbox address — Gmail's own key (§3.1) — instead of
 * tenantId, so two tenants sharing one mailbox (the deliberate one-at-a-time
 * shared-test-mailbox handover, §5) pace against ONE schedule instead of
 * silently doubling the admitted rate. But quota-limiter.ts's own header
 * commits to a deliberately tiny dependency budget (@repo/logger and the pure
 * ./gmail-errors only) specifically so gmail-request.ts cannot reach a gate
 * through it — and a DB read to resolve a mailbox is real I/O on the pacing
 * hot path, which that budget exists to keep out. So resolution happens HERE,
 * in the two callers that already know the tenant (gmail-request.ts,
 * retry.ts), and only the resolved string crosses into the limiter.
 *
 * CACHED, WITH TWO INVALIDATION PATHS THAT MUST BOTH STAY CORRECT.
 *   1. Bounded TTL (backstop) — a resolver that only ever trusted the cache
 *      "because the binding is immutable in practice" is exactly the B-3
 *      class of bug: quietly attributing one mailbox's quota to another.
 *   2. Explicit invalidation, at the only two sites that write the
 *      tenantId<->mailbox binding: `storeGmailConnectedEmail` and
 *      `rollbackGmailConnection` (tenant/index.ts). A RECONNECT can re-point
 *      an existing mailbox from tenant A to tenant B (the upsert there
 *      targets emailAddress, not tenantId) — so invalidation on write must
 *      clear BOTH the incoming tenant's entry and, when the row already
 *      belonged to someone else, the PRIOR tenant's entry too. Missing that
 *      second half is the same bug wearing a different hat: tenant A's cache
 *      entry goes stale and keeps pacing against a mailbox it no longer owns.
 *
 * A resolver miss (nothing cached, nothing in the DB, or the DB read itself
 * failing) returns `undefined` and NEVER throws — quota-limiter.ts's
 * `bucketKey` falls back to tenantId, then "unattributed", so a miss paces
 * conservatively rather than escaping pacing. This module must not be the
 * thing that turns a database hiccup into an unpaced Gmail call.
 */

import { db, eq } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { logger } from "@repo/logger";

/** Backstop only — explicit invalidation is the real correctness mechanism. */
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  mailbox: string | null;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Resolves and caches. Never throws — a DB failure here must never be able
 * to fail (or even delay past this lookup) the Gmail call the resolver was
 * asked to help price.
 */
export async function resolveMailboxForTenant(tenantId: string): Promise<string | undefined> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.mailbox ?? undefined;
  }

  try {
    const [row] = await db
      .select({ emailAddress: gmailTenantMappings.emailAddress })
      .from(gmailTenantMappings)
      .where(eq(gmailTenantMappings.tenantId, tenantId))
      .limit(1);

    const mailbox = row?.emailAddress ?? null;
    cache.set(tenantId, { mailbox, cachedAt: Date.now() });
    return mailbox ?? undefined;
  } catch (err) {
    logger.warn("[GMAIL_MAILBOX_RESOLVER] lookup failed, pacing will fall back to tenantId", {
      tenantId,
      error: String(err),
    });
    // Deliberately NOT cached: a transient DB failure should not pin this
    // tenant to "no mailbox" for the full TTL once the DB recovers.
    return cached?.mailbox ?? undefined;
  }
}

/**
 * Invalidate one tenant's cached mailbox. Call at every site that writes or
 * deletes the tenantId<->mailbox binding — see the module doc comment for
 * why a re-point needs BOTH the old and new tenant id invalidated.
 */
export function invalidateMailboxCache(tenantId: string): void {
  cache.delete(tenantId);
}

/** Test seam. */
export function __resetMailboxResolverCache(): void {
  cache.clear();
}
