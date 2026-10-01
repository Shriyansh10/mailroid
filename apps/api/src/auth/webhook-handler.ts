import { inngest } from "@repo/inngest";
import { db, eq } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { syncHistoryForTenant } from "@repo/services/gmail/webhook-sync.js";
import {
  classifyGmailFailure,
  clearWebhookMarker,
  getCooldown,
  markWebhookInFlight,
  recordWebhookFailure,
} from "@repo/services/gmail/quota-cooldown.js";
import { ackStatusForDispatch, parseGmailPush } from "@repo/services/gmail/webhook-push.js";
import { getPause } from "@repo/services/gmail/pause.js";
import { withTenantSingleFlight } from "@repo/services/gmail/tenant-lock.js";
import { syncCalendarEvents } from "@repo/services/calendar/sync-events.js";
import { logger, errorFields, hashMailbox, preview } from "@repo/logger";
import { isMailboxAllowedInThisEnvironment, mailroidEnv } from "@repo/services/env.js";
import { describeError } from "../diagnostics/describe-error.js";
import { recordUnmappedPush } from "../diagnostics/unmapped-push-counter.js";

// Stage 3 rollout flag (see docs/architecture-plan.md). false = the History
// diff still runs inline in this Express handler as a fire-and-forget
// promise (legacy behavior, kept for one release as the rollback path).
// true = it's handed to gmailWebhookSync (webhook-inngest.ts), which is
// durable, retries on failure, and serializes per-tenant so two
// notifications for the same mailbox can't race and rewind the cursor. The
// actual diff/ingest/cursor-advance logic lives in exactly one place
// (webhook-sync.ts) either way.
const WEBHOOK_VIA_INNGEST = process.env.WEBHOOK_VIA_INNGEST === "true";

/**
 * `lookupFailed` is distinct from "no mapping" on purpose. Both used to return
 * undefined, so a database error was acked as an unmapped mailbox and the
 * delivery was gone. A missing row is a fact worth acking; a failed lookup is
 * not knowledge of anything, and the caller NACKs it so Pub/Sub redelivers.
 */
async function resolveTenantIdFromEmail(
  targetEmail: string,
): Promise<{ tenantId?: string; lookupFailed: boolean }> {
  const targetEmailLower = targetEmail.toLowerCase();
  // The address IS the lookup key here and no tenantId exists yet, so this is
  // the narrow case hashMailbox is for. It never reaches a log in the clear.
  const mailbox = hashMailbox(targetEmailLower);

  try {
    const [mapping] = await db
      .select({ tenantId: gmailTenantMappings.tenantId })
      .from(gmailTenantMappings)
      .where(eq(gmailTenantMappings.emailAddress, targetEmailLower));

    if (mapping) {
      logger.debug("[WEBHOOK] tenant resolved", { mailbox, tenantId: mapping.tenantId });
      return { tenantId: mapping.tenantId, lookupFailed: false };
    }

    // Loud (error, not warn) and countable — see unmapped-push-counter.ts.
    // This IS what an orphaned or stolen watch looks like from here (§9.2),
    // and a warn that scrolls past is how it went uncounted for 14+ hours.
    recordUnmappedPush();
    logger.error("[WEBHOOK] no tenant mapping for mailbox", { mailbox });
    return { lookupFailed: false };
  } catch (err) {
    logger.error("[WEBHOOK] tenant resolution lookup failed", {
      mailbox,
      ...errorFields(err),
    });
    return { lookupFailed: true };
  }
}

/** The handler's return shape, as server.ts consumes it. */
function respond(plugin: string, action: string, statusCode: number, data: unknown) {
  return { plugin, action, response: { statusCode, responseHeaders: {}, data } };
}

/**
 * Handle Google push notifications: Calendar watch channels and Gmail Pub/Sub.
 *
 * Calendar pushes are identified by `x-goog-channel-id` and handled first.
 * Gmail pushes are decoded here (parseGmailPush) and dispatched to Mailroid's
 * own paced history sync.
 *
 * CORSAIR'S processWebhook IS DELIBERATELY NOT CALLED. Its Gmail handler made
 * its own unpaced, unledgered Gmail calls on every delivery — full and raw
 * messages.get per changed message, attachments, and 21 requests on a delivery
 * with nothing new — and that hidden traffic is what was exhausting mailboxes'
 * per-minute quota. See webhook-push.ts. Corsair remains the Gmail API client
 * and the OAuth/token store; only its webhook processing is bypassed.
 */
export async function handleCorsairWebhook(req: {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  url: string;
}) {
  const parsedUrl = new URL(req.url, "http://localhost");
  let tenantId = parsedUrl.searchParams.get("tenantId") ?? undefined;

  // Resolve calendar tenantId from the x-goog-channel-id header
  let calendarTenantId: string | undefined = undefined;
  const channelId = req.headers["x-goog-channel-id"];
  if (typeof channelId === "string") {
    try {
      const [mapping] = await db
        .select({ tenantId: calendarTenantMappings.tenantId })
        .from(calendarTenantMappings)
        .where(eq(calendarTenantMappings.channelId, channelId))
        .limit(1);
      if (mapping) {
        calendarTenantId = mapping.tenantId;
        logger.debug("[WEBHOOK] calendar tenant resolved", {
          tenantId: calendarTenantId,
          channelId,
        });
      }
    } catch (err) {
      logger.error("[WEBHOOK] calendar channel lookup failed", {
        channelId,
        ...errorFields(err),
      });
    }
  }

  // ── Handle Direct Google Calendar Webhook Push Notifications ────────
  const resourceState = req.headers["x-goog-resource-state"];
  if (typeof channelId === "string") {
    logger.debug("[WEBHOOK] calendar push received", { channelId, resourceState });
    
    if (calendarTenantId) {
      if (resourceState === "sync") {
        logger.debug("[WEBHOOK] calendar channel sync handshake", { channelId });
        return {
          plugin: "googlecalendar",
          action: "sync",
          response: {
            statusCode: 200,
            responseHeaders: {},
            data: { message: "Sync channel verified" }
          }
        };
      }

      void (async () => {
        try {
          await syncCalendarEvents(calendarTenantId);
          logger.debug("[WEBHOOK] background calendar sync completed", {
            tenantId: calendarTenantId,
          });
        } catch (err) {
          logger.error("[WEBHOOK] background calendar sync failed", {
            tenantId: calendarTenantId,
            ...errorFields(err),
          });
        }
      })();

      return {
        plugin: "googlecalendar",
        action: "onEventChanged",
        response: {
          statusCode: 200,
          responseHeaders: {},
          data: { success: true }
        }
      };
    } else {
      // Orphan channel: a watch we've since replaced (or one belonging to a
      // never-onboarded account) is still pushing. We can't map it to a tenant,
      // so ack with 200 and stop here — a Calendar push must never fall through
      // to the Gmail path below. 200 also tells
      // Google the delivery succeeded so it won't retry. The real fix is
      // stopping old channels on re-register (see startCalendarWatch); these
      // pings stop once the orphan channel expires.
      logger.warn("[WEBHOOK] ignoring orphan calendar channel", {
        channelId,
        outcome: "ignoredOrphanChannel",
      });
      return {
        plugin: "googlecalendar",
        action: "ignoredOrphanChannel",
        response: {
          statusCode: 200,
          responseHeaders: {},
          data: { ignored: true },
        },
      };
    }
  }

  const push = parseGmailPush(req.body);

  /**
   * Pub/Sub's own message id, used as the correlation id for everything this
   * delivery causes.
   *
   * THIS IS A STRONGER SIGNAL THAN incomingHistoryId. A repeated historyId is
   * only *evidence of* repeated delivery — two genuinely distinct notifications
   * can carry the same history position. A repeated `messageId` is Pub/Sub
   * redelivering the identical message, which is the thing H-A actually claims.
   * Carrying it means the ledger can say "412 history.list calls under 3 message
   * ids" — redelivery — as distinct from "412 under 412 ids" — real churn.
   *
   * Not PII: an opaque Pub/Sub identifier, no mailbox in it.
   */
  const deliveryId = push.deliveryId;

  if (!push.ok) {
    if (push.reason === "not-pubsub") {
      // Neither a Calendar channel push (handled above) nor a Pub/Sub envelope.
      // Nothing to process and nothing a redelivery would fix.
      logger.warn("[WEBHOOK] ignoring unrecognised push", { outcome: "ignoredUnrecognisedPush" });
      return respond("unknown", "ignoredUnrecognisedPush", 200, { ignored: true });
    }

    // preview(), never the body: a Pub/Sub payload decodes to a mailbox
    // address, and an unparseable one is exactly when someone is tempted to
    // dump the lot. Acked: a malformed envelope is malformed on every
    // redelivery too.
    const data = (req.body as { message?: { data?: unknown } } | undefined)?.message?.data;
    logger.error("[WEBHOOK] could not parse Pub/Sub message data", {
      reason: push.reason,
      deliveryId,
      bodyPreview: preview(typeof data === "string" ? data : ""),
      outcome: "ignoredMalformedPush",
    });
    return respond("gmail", "ignoredMalformedPush", 200, { ignored: true });
  }

  const incomingHistoryId = push.historyId;

  // P-1's allowlist (docs/gmail-rate-limit-boundary.md §13) only guards NEW
  // OAuth connects. A mailbox that was already (mis)connected before that
  // shipped — §8.4's confirmed local/production overlap — never passes
  // through that check again; it just keeps pushing here. This flag marks the
  // second enforcement point, below, so the eventual 200 ack names the real
  // reason instead of being folded into the generic "unmapped mailbox" case.
  let droppedForWrongEnvironment = false;

  if (!tenantId && push.emailAddress) {
    const email = push.emailAddress;

    // Checked BEFORE the mapping lookup, and independent of whether a mapping
    // exists. §8.4's overlapping mailboxes ARE mapped locally — that's the
    // incident — so "is it mapped" cannot be the gate. The allowlist is the
    // one source of truth for ownership (1a); a push for a mailbox this
    // environment does not own is dropped here regardless of what
    // gmail_tenant_mappings says.
    if (!isMailboxAllowedInThisEnvironment(email)) {
      droppedForWrongEnvironment = true;
      logger.error("[WEBHOOK] dropping gmail push: mailbox not owned by this environment", {
        mailbox: hashMailbox(email),
        mailroidEnv: mailroidEnv.env,
        outcome: "droppedWrongEnvironmentMailbox",
      });
    } else {
      const resolved = await resolveTenantIdFromEmail(email);
      if (resolved.lookupFailed) {
        // We do not know whose mailbox this is, so we cannot make it
        // recoverable. NACK: a redelivery costs database reads, not Gmail
        // quota, and Pub/Sub backs off on its own.
        return respond("gmail", "deferredTenantLookupFailed", 503, { deferred: true });
      }
      if (resolved.tenantId) tenantId = resolved.tenantId;
    }
  }

  // ONE STRUCTURED LINE PER DELIVERY, and incomingHistoryId is the field that
  // matters. Repeated values are EVIDENCE OF repeated delivery of the same
  // history position; distinct values indicate different positions. Neither on
  // its own proves the source of churn — correlate with sync start/end and the
  // call ledger before concluding.
  logger.info("[WEBHOOK] delivery", {
    tenantId,
    incomingHistoryId,
    // Repeats here mean Pub/Sub redelivered the identical message. Repeats of
    // incomingHistoryId alone do not carry that — see the deliveryId comment.
    deliveryId,
    hasCalendarChannel: false,
  });

  // Gmail Pub/Sub push for a mailbox we don't manage — a watch registered for a
  // never-onboarded account (e.g. a stray test account still publishing to the
  // dev topic). Ack 200 and stop; these pings stop once that account's watch
  // expires.
  if (!tenantId) {
    // The loud error line already ran above for the wrong-environment case —
    // this is just the required 200 ack, with the action field naming which
    // of the two guards fired rather than folding both into one label.
    if (!droppedForWrongEnvironment) {
      logger.warn("[WEBHOOK] ignoring gmail push for unmapped mailbox", {
        incomingHistoryId,
        outcome: "ignoredUnmappedMailbox",
      });
    }
    return respond(
      "gmail",
      droppedForWrongEnvironment ? "droppedWrongEnvironmentMailbox" : "ignoredUnmappedMailbox",
      200,
      { ignored: true },
    );
  }

  // An operator pause outranks everything: a paused mailbox makes zero Google
  // calls, full stop. Acked 200 — a non-2xx is a NACK and Pub/Sub would
  // redeliver for 7 days. The cursor has not moved, so the diff is re-fetched
  // once resumed.
  const pause = await getPause(tenantId).catch(() => null);
  if (pause) {
    logger.warn("[WEBHOOK] sync paused, acking without calling Gmail", {
      tenantId,
      incomingHistoryId,
      mode: pause.mode,
      until: pause.expiresAt?.toISOString() ?? null,
      outcome: "deferredPaused",
    });
    return respond("gmail", "deferredPaused", 200, { deferred: true, paused: true, mode: pause.mode });
  }

  // Google has told us this mailbox is rate-limited until a specific instant,
  // and every request made before then pushes that instant FURTHER OUT. Ack
  // without calling Gmail: the cursor has not moved, and the resume cron
  // re-drives the mailbox once the window passes. The mailbox recovers because
  // of the calls we DON'T make.
  const cooldown = await getCooldown(tenantId).catch(() => null);
  if (cooldown) {
    logger.warn("[WEBHOOK] quota cooldown active, acking without calling Gmail", {
      tenantId,
      incomingHistoryId,
      retryAfter: cooldown.until.toISOString(),
      outcome: "deferredRateLimited",
    });
    return respond("gmail", "deferredRateLimited", 200, {
      deferred: true,
      retryAfter: cooldown.until.toISOString(),
    });
  }

  // DURABLE BEFORE ACK. From here on the delivery is acked 200 whatever
  // happens to the sync, so first leave a marker that only a completed sync
  // removes. If the sync fails, Inngest gives up, or this process dies
  // mid-diff, the marker remains and the hourly resume cron re-drives the
  // mailbox from its unmoved cursor. If the marker itself cannot be written,
  // nothing would remain to recover from — so NACK instead.
  let markerAt: Date;
  try {
    markerAt = await markWebhookInFlight(tenantId);
  } catch (err) {
    logger.error("[WEBHOOK] could not record in-flight marker, NACKing for redelivery", {
      tenantId,
      incomingHistoryId,
      deliveryId,
      outcome: "nackedMarkerWriteFailed",
      ...errorFields(err),
    });
    return respond("gmail", "nackedMarkerWriteFailed", ackStatusForDispatch(false), {
      deferred: true,
    });
  }

  logger.info("[WEBHOOK] gmail history sync starting", {
    tenantId,
    incomingHistoryId,
    via: WEBHOOK_VIA_INNGEST ? "inngest" : "in-process",
  });

  if (WEBHOOK_VIA_INNGEST) {
    // Durable once accepted: gmailWebhookSync retries on failure, serializes
    // per tenant, and clears the marker only after its sync step completes.
    try {
      await inngest.send({
        name: "gmail/webhook.notification",
        data: {
          tenantId,
          incomingHistoryId,
          correlationId: deliveryId,
          markerAt: markerAt.toISOString(),
        },
      });
    } catch (err) {
      // Still acked: the marker is durable, so the resume cron picks this up.
      logger.error("[WEBHOOK] inngest send failed; marker left for the resume cron", {
        tenantId,
        incomingHistoryId,
        deliveryId,
        outcome: "dispatchFailed",
        ...errorFields(err),
      });
      await recordDispatchFailure(tenantId, err);
    }
  } else {
    // Legacy path, kept for one release as the rollback for
    // WEBHOOK_VIA_INNGEST. Serialised per tenant: without this, N overlapping
    // deliveries for one mailbox each start their own diff, and
    // ingestAllOrThrow's concurrency cap is per-delivery — so the real Gmail
    // concurrency is N × 2, which is how a busy mailbox talks itself into a
    // rate limit.
    void withTenantSingleFlight(`gmail:${tenantId}`, async () => {
      // Re-check AFTER acquiring: this delivery may have been queued before
      // the predecessor hit a 429 and opened a cooldown. Acting on the stale
      // pre-queue check would fire one more doomed call and push Google's
      // window further out. The marker stays; the resume cron handles it once
      // the cooldown expires.
      if (await getCooldown(tenantId)) {
        logger.warn("[WEBHOOK] cooldown opened while queued, skipping sync", {
          tenantId,
          incomingHistoryId,
          deliveryId,
          outcome: "skippedCooldownOnDequeue",
        });
        return;
      }
      await syncHistoryForTenant(tenantId, incomingHistoryId, {
        correlationId: deliveryId,
      });
      // Only a sync that completed may clear the marker, and only its own or
      // an older one — see clearWebhookMarker.
      await clearWebhookMarker(tenantId, markerAt);
    }).catch(async (err) => {
      logger.error("[WEBHOOK] syncHistoryForTenant failed", {
        tenantId,
        incomingHistoryId,
        deliveryId,
        outcome: "syncFailed",
        ...errorFields(err),
      });
      await recordDispatchFailure(tenantId, err);
    });
  }

  return respond("gmail", "messageChanged", ackStatusForDispatch(true), {});
}

/**
 * Durable health, because acking removed the 500 that used to announce a
 * broken mailbox and an error log is the only other trace — and logs rotate.
 * This is what /api/_debug/watch-health reads.
 *
 * Never the only safety net: the in-flight marker written before the ack
 * already guarantees the resume cron finds this mailbox. This adds the reason,
 * and moves the marker's timestamp forward so an older sync's clear cannot
 * erase it. A failure to write it is logged, not thrown.
 */
async function recordDispatchFailure(tenantId: string, err: unknown): Promise<void> {
  const kind = classifyGmailFailure(err);
  const reason =
    kind === "quota"
      ? "GMAIL_429"
      : kind === "auth"
        ? "GMAIL_AUTH_FAILED"
        : String(describeError(err)).slice(0, 300);
  await recordWebhookFailure(tenantId, reason).catch((writeErr) => {
    logger.error("[WEBHOOK] could not record webhook failure; in-flight marker still stands", {
      tenantId,
      ...errorFields(writeErr),
    });
  });
}
