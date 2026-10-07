/**
 * Clearing the mailbox-level authentication latch, and nothing else.
 *
 * WHY THIS IS ITS OWN MODULE. `gmail_auth_failed_at` is set by
 * recordAuthFailure and read by assertAuthHealthy, both in quota-cooldown.ts —
 * so the obvious home for the clear is there too. It cannot live there, because
 * the one place that needs to call it is gmail-request.ts, whose stated
 * invariant is that it imports no gate:
 *
 *     NOTE THE IMPORTS THAT ARE DELIBERATELY ABSENT: withGmailRetry,
 *     assertSyncAllowed, assertNotCoolingDown, assertNotPaused.
 *
 * Importing quota-cooldown.ts for one function would make every gate reachable
 * from the authentication-recovery path and reintroduce the deadlock that file
 * exists to prevent. So this is deliberately a leaf: db, the model, the logger.
 * Nothing else may be imported here.
 *
 * THE DEADLOCK THIS FIXES. gmail-request.ts removed one cycle:
 *
 *     cooldown -> blocks refresh -> token stays stale -> 401 -> cooldown
 *
 * but left its mirror image, because bypassing every gate also bypassed
 * markGmailHealthy — the only writer that nulls the latch:
 *
 *     auth latch -> blocks every gated call
 *                -> only a gated call clears the latch
 *                -> latch stays set forever
 *
 * Observed in the wild: a mailbox whose consent had genuinely lapsed was
 * reconnected, `users.getProfile` and `users.watch` both succeeded against
 * Google with the fresh token, and every sync stayed blocked for hours
 * afterwards, replaying a stored failure reason from before the reconnect
 * without ever contacting Google again. Reconnecting a second time changed
 * nothing, because nothing on that path could clear what was blocking it.
 */

import { db, and, eq, isNotNull } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { logger } from "@repo/logger";

/**
 * Clear the auth latch for a mailbox whose credentials have just demonstrably
 * worked.
 *
 * ONLY THE AUTH FIELDS. A successful authentication-recovery call proves the
 * credentials are good; it proves nothing about a quota cooldown, which is a
 * separate state with its own evidence and its own clearing path
 * (markGmailHealthy). Resetting quota fields from here would let one 1-unit
 * profile fetch wave away a 60-minute rate-limit block.
 *
 * HOT PATH. This runs after successful recovery calls, so the common case must
 * not cost a write: the `IS NOT NULL` predicate means a healthy mailbox updates
 * zero rows, and `returning` tells us whether anything actually changed without
 * a second query.
 *
 * Never throws. A mailbox that just worked must not have its call fail over
 * bookkeeping — the same contract markGmailHealthy keeps.
 *
 * NOTE: quota-cooldown.ts memoises this row for MEMO_TTL_MS (5s) in-process, so
 * a gate may refuse for up to that long after this clear before re-reading. The
 * latch is measured in hours; five seconds of staleness is not worth coupling
 * the two modules to erase.
 */
export async function clearGmailAuthLatch(
  tenantId: string,
  ctx: { trigger?: string; operation?: string } = {},
): Promise<void> {
  try {
    const cleared = await db
      .update(gmailTenantMappings)
      .set({ gmailAuthFailedAt: null, gmailAuthFailureReason: null })
      .where(
        and(
          eq(gmailTenantMappings.tenantId, tenantId),
          isNotNull(gmailTenantMappings.gmailAuthFailedAt),
        ),
      )
      .returning({ tenantId: gmailTenantMappings.tenantId });

    // Logged only on an actual recovery. A mailbox that was never latched is
    // the overwhelmingly common case and says nothing worth a line.
    if (cleared.length > 0) {
      logger.info("[GMAIL_AUTH] auth latch cleared, mailbox recovered", {
        tenantId,
        trigger: ctx.trigger,
        operation: ctx.operation,
      });
    }
  } catch (err) {
    logger.error("[GMAIL_AUTH] failed to clear auth latch after a successful call", {
      tenantId,
      trigger: ctx.trigger,
      operation: ctx.operation,
      error: String(err),
    });
  }
}
