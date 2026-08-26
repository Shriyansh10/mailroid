import { corsair } from "@repo/corsair";
import { processWebhook } from "corsair";
import { inngest } from "@repo/inngest";
import { db, eq, and } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { calendarEvents } from "@repo/database/models/calendar-events";
import { syncHistoryForTenant } from "@repo/services/gmail/webhook-sync.js";
import {
  classifyGmailFailure,
  getCooldown,
  handleGmailFailure,
  recordWebhookFailure,
  clearWebhookFailure,
} from "@repo/services/gmail/quota-cooldown.js";
import { getPause } from "@repo/services/gmail/pause.js";
import { withTenantSingleFlight } from "@repo/services/gmail/tenant-lock.js";
import { syncCalendarEvents } from "@repo/services/calendar/sync-events.js";
import { logger, errorFields, hashMailbox, preview } from "@repo/logger";
import { describeError } from "../diagnostics/describe-error.js";

// Stage 3 rollout flag (see docs/architecture-plan.md). false = the History
// diff still runs inline in this Express handler as a fire-and-forget
// promise (legacy behavior, kept for one release as the rollback path).
// true = it's handed to gmailWebhookSync (webhook-inngest.ts), which is
// durable, retries on failure, and serializes per-tenant so two
// notifications for the same mailbox can't race and rewind the cursor. The
// actual diff/ingest/cursor-advance logic lives in exactly one place
// (webhook-sync.ts) either way.
const WEBHOOK_VIA_INNGEST = process.env.WEBHOOK_VIA_INNGEST === "true";

async function resolveTenantIdFromEmail(targetEmail: string): Promise<string | undefined> {
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
      return mapping.tenantId;
    }

    logger.warn("[WEBHOOK] no tenant mapping for mailbox", { mailbox });
  } catch (err) {
    logger.error("[WEBHOOK] tenant resolution lookup failed", {
      mailbox,
      ...errorFields(err),
    });
  }

  return undefined;
}

/**
 * Handle incoming Corsair webhooks from all plugins.
 *
 * processWebhook inspects headers + body to determine:
 * - Which integration the webhook is from
 * - Which event type it represents
 * - Which tenant it belongs to (via ?tenantId= query param)
 *
 * Then auto-upserts data into corsair_entities / corsair_events.
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
      // so ack with 200 and stop here — falling through to processWebhook would
      // resolve tenant "default" and throw "Account not found". 200 also tells
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

  let incomingHistoryId: string | undefined = undefined;

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
  let deliveryId: string | undefined = undefined;

  // Resolve tenantId and extract historyId from Gmail Pub/Sub webhook body
  if (req.body && typeof req.body === "object") {
    const body = req.body as Record<string, any>;
    if (body.message && typeof body.message.messageId === "string") {
      deliveryId = body.message.messageId;
    }
    if (body.message && typeof body.message.data === "string") {
      try {
        const decodedData = Buffer.from(body.message.data, "base64").toString("utf-8");
        const dataObj = JSON.parse(decodedData);
        if (dataObj) {
          if (typeof dataObj.historyId === "string") {
            incomingHistoryId = dataObj.historyId;
          } else if (typeof dataObj.historyId === "number") {
            incomingHistoryId = String(dataObj.historyId);
          }

          if (!tenantId && typeof dataObj.emailAddress === "string") {
            const email = dataObj.emailAddress;
            const resolvedId = await resolveTenantIdFromEmail(email);
            if (resolvedId) {
              tenantId = resolvedId;
            } else {
              logger.warn("[WEBHOOK] unresolvable mailbox on gmail push", {
                mailbox: hashMailbox(email),
              });
            }
          }
        }
      } catch (e) {
        // preview(), never the body: a Pub/Sub payload decodes to a mailbox
        // address, and an unparseable one is exactly when someone is tempted
        // to dump the lot.
        logger.error("[WEBHOOK] could not parse Pub/Sub message data", {
          bodyPreview: preview(body.message.data),
          ...errorFields(e),
        });
      }
    }
  }

  // ONE STRUCTURED LINE PER DELIVERY, and incomingHistoryId is the field that
  // matters. Repeated values are EVIDENCE OF repeated delivery of the same
  // history position; distinct values indicate different positions. Neither on
  // its own proves the source of churn — correlate with sync start/end and the
  // call ledger before concluding.
  //
  // The previous line logged a 200-character preview of the raw body, which is
  // a base64 Pub/Sub envelope wrapping the mailbox address. Dropped: nothing
  // read it, and it was the only PII on the happy path.
  logger.info("[WEBHOOK] delivery", {
    tenantId,
    incomingHistoryId,
    // Repeats here mean Pub/Sub redelivered the identical message. Repeats of
    // incomingHistoryId alone do not carry that — see the deliveryId comment.
    deliveryId,
    hasCalendarChannel: typeof channelId === "string",
  });

  // Gmail Pub/Sub push for a mailbox we don't manage — a watch registered for a
  // never-onboarded account (e.g. a stray test account still publishing to the
  // dev topic). `incomingHistoryId` set with no resolvable tenant identifies it.
  // Ack 200 and stop: falling through to processWebhook resolves tenant
  // "default", which has no gmail account, and throws "Account not found". This
  // is the Gmail twin of the orphan-calendar-channel guard above; these pings
  // stop once that account's watch expires. (Calendar pushes are handled
  // earlier via channelId, so this only catches the Gmail path.)
  if (!tenantId && incomingHistoryId) {
    logger.warn("[WEBHOOK] ignoring gmail push for unmapped mailbox", {
      incomingHistoryId,
      outcome: "ignoredUnmappedMailbox",
    });
    return {
      plugin: "gmail",
      action: "ignoredUnmappedMailbox",
      response: {
        statusCode: 200,
        responseHeaders: {},
        data: { ignored: true },
      },
    };
  }

  // Google has told us this mailbox is rate-limited until a specific instant,
  // and every request made before then pushes that instant FURTHER OUT. Stop
  // here rather than at the catch below: processWebhook is third-party and
  // calls Gmail itself, so merely catching its throw would still spend one
  // Gmail call per Pub/Sub redelivery — ~4/min for the 7-day retention — and
  // hold the window open indefinitely. The mailbox recovers because of the
  // calls we DON'T make.
  //
  // Ack 200 for the same reason as the two guards above: a non-2xx is a NACK
  // and Pub/Sub redelivers. Nothing is lost — lastHistoryId has not advanced,
  // so the diff is re-fetched once the window passes, either on the next
  // notification or via the reconciliation sweep.
  const activeTenant = tenantId ?? calendarTenantId;
  // Scoped to `tenantId` (the Gmail mailbox), NOT activeTenant. The cooldown is
  // a Gmail quota fact and must never suppress a Calendar push — those go
  // through a different API with its own quota, and dropping them here would
  // trade one outage for a quieter one.
  if (tenantId) {
    // An operator pause outranks everything: a paused mailbox makes zero Google
    // calls, full stop. Acked 200 for the same reason as the cooldown branch
    // below — a non-2xx is a NACK and Pub/Sub would redeliver every ~15s for 7
    // days. The cursor has not moved, so the diff is re-fetched once resumed.
    const pause = await getPause(tenantId).catch(() => null);
    if (pause) {
      logger.warn("[WEBHOOK] sync paused, acking without calling Gmail", {
        tenantId,
        incomingHistoryId,
        mode: pause.mode,
        until: pause.expiresAt?.toISOString() ?? null,
        outcome: "deferredPaused",
      });
      return {
        plugin: "gmail",
        action: "deferredPaused",
        response: {
          statusCode: 200,
          responseHeaders: {},
          data: { deferred: true, paused: true, mode: pause.mode },
        },
      };
    }

    const cooldown = await getCooldown(tenantId).catch(() => null);
    if (cooldown) {
      logger.warn("[WEBHOOK] quota cooldown active, acking without calling Gmail", {
        tenantId,
        incomingHistoryId,
        retryAfter: cooldown.until.toISOString(),
        outcome: "deferredRateLimited",
      });
      return {
        plugin: "gmail",
        action: "deferredRateLimited",
        response: {
          statusCode: 200,
          responseHeaders: {},
          data: { deferred: true, retryAfter: cooldown.until.toISOString() },
        },
      };
    }
  }

  let result: Awaited<ReturnType<typeof processWebhook>>;
  try {
    result = await processWebhook(
      corsair,
      Object.fromEntries(
        Object.entries(req.headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      req.body as any,
      { tenantId: activeTenant },
    );
  } catch (err) {
    // Ack 200 for EVERY failure here, not only quota ones. Pub/Sub redelivery
    // cannot repair a fault in our handler — it just replays it every ~15s for
    // 7 days, turning one bad request into a sustained load. Retrying is our
    // job, on our schedule, not Google's.
    // Classify once, here, and let handleGmailFailure decide what to write. It
    // used to call recordQuotaError directly behind an isQuotaError check —
    // correct, but the check was the caller's to remember, and the one caller
    // that forgot (cooldown-resume-cron) deadlocked production for four days.
    // recordQuotaError is now private precisely so this cannot drift again.
    const kind = classifyGmailFailure(err);
    const quota = kind === "quota";

    // Both writes target gmail_tenant_mappings, so they are keyed on the Gmail
    // tenant only. A calendar-only push has no row there and would silently
    // update nothing.
    if (tenantId) {
      await handleGmailFailure(tenantId, err, {
        trigger: "webhook",
        operation: "processWebhook",
        targetId: incomingHistoryId,
      }).catch(() => {});

      // Durable health, because acking removed the 500 that used to announce a
      // broken mailbox and an error log is the only other trace — and logs
      // rotate. This is what /api/_debug/watch-health reads.
      await recordWebhookFailure(
        tenantId,
        quota
          ? "GMAIL_429"
          : kind === "auth"
            ? "GMAIL_AUTH_FAILED"
            : String(describeError(err)).slice(0, 300),
      ).catch(() => {});
    }

    // retryAfter is read back from the cooldown row rather than returned by the
    // recorder: handleGmailFailure deliberately has no return value, because a
    // caller that needs one is a caller tempted to branch on the failure kind
    // itself.
    const retryAfter = quota && tenantId ? (await getCooldown(tenantId))?.until : undefined;

    logger.error("[WEBHOOK] processWebhook failed, acking 200 to stop redelivery", {
      tenantId: activeTenant,
      incomingHistoryId,
      deliveryId,
      kind,
      quota,
      retryAfter: retryAfter?.toISOString(),
      outcome: quota ? "deferredRateLimited" : "deferredError",
      ...errorFields(err),
    });

    return {
      plugin: "gmail",
      action: quota ? "deferredRateLimited" : "deferredError",
      response: {
        statusCode: 200,
        responseHeaders: {},
        data: { deferred: true, retryAfter: retryAfter?.toISOString() },
      },
    };
  }
  // The whole result was previously dumped TWICE, pretty-printed, at info, on
  // every delivery — mail metadata included. Plugin and action are what anyone
  // actually reads; the payload stays available at debug when genuinely needed.
  logger.debug("[WEBHOOK] processed", {
    tenantId: activeTenant,
    plugin: result.plugin,
    action: result.action,
  });

  // Unified realtime email ingestion path via Gmail History API
  if (
    result.plugin === "gmail" &&
    result.action === "messageChanged" &&
    tenantId &&
    incomingHistoryId
  ) {
    logger.info("[WEBHOOK] gmail history sync starting", {
      tenantId,
      incomingHistoryId,
      via: WEBHOOK_VIA_INNGEST ? "inngest" : "in-process",
    });

    // processWebhook got through, so whatever was wrong before is no longer
    // wrong. Clearing here (rather than after ingest) keeps the flag meaning
    // one precise thing — "the webhook itself failed" — instead of blurring
    // into downstream ingest failures, which have their own retry paths.
    void clearWebhookFailure(tenantId).catch(() => {});

    if (WEBHOOK_VIA_INNGEST) {
      // Durable: an Inngest event send is itself reliable, and the function
      // it triggers (gmailWebhookSync) retries on failure and serializes
      // per-tenant. Returns to the Pub/Sub sender immediately either way.
      await inngest.send({
        name: "gmail/webhook.notification",
        data: { tenantId, incomingHistoryId, correlationId: deliveryId },
      });
    } else {
      // Legacy path, kept for one release as the rollback for
      // WEBHOOK_VIA_INNGEST. Same fire-and-forget shape as before, but now
      // delegates to the shared syncHistoryForTenant so the ordering fix
      // (store before advancing the cursor) applies here too.
      // Serialised per tenant. Without this, N overlapping deliveries for one
      // mailbox each start their own diff, and ingestAllOrThrow's concurrency
      // cap is per-delivery — so the real Gmail concurrency is N × 2, which is
      // how a busy mailbox talks itself into a rate limit.
      void withTenantSingleFlight(`gmail:${tenantId}`, async () => {
        // Re-check AFTER acquiring: this delivery may have been queued before
        // the predecessor hit a 429 and opened a cooldown. Acting on the stale
        // pre-queue check would fire one more doomed call and push Google's
        // window further out — the exact loop we're removing.
        if (await getCooldown(tenantId)) {
          logger.warn("[WEBHOOK] cooldown opened while queued, skipping sync", {
            tenantId,
            incomingHistoryId,
            deliveryId,
            outcome: "skippedCooldownOnDequeue",
          });
          return;
        }
        return syncHistoryForTenant(tenantId, incomingHistoryId, {
          correlationId: deliveryId,
        });
      }).catch((err) => {
        logger.error("[WEBHOOK] syncHistoryForTenant failed", {
          tenantId,
          incomingHistoryId,
          deliveryId,
          ...errorFields(err),
        });
      });
    }
  }

  // Google Calendar webhook sync logic
  if (result.plugin === "googlecalendar") {
    logger.debug("[WEBHOOK] calendar result", {
      tenantId: tenantId ?? calendarTenantId,
      action: result.action,
    });

    const activeTenantId = tenantId ?? calendarTenantId;
    const resultAny = result as any;
    if (activeTenantId && resultAny.action === "onEventChanged") {
      const data = resultAny.data;
      if (data) {
        void (async () => {
          try {
            if (data.type === "eventCreated" || data.type === "eventUpdated") {
              const event = data.event;
              if (event && event.id) {
                const start = event.start?.dateTime ?? event.start?.date;
                const end = event.end?.dateTime ?? event.end?.date;
                await db
                  .insert(calendarEvents)
                  .values({
                    userId: activeTenantId,
                    eventId: event.id,
                    title: event.summary ?? "(No title)",
                    startTime: start ? new Date(start) : new Date(),
                    endTime: end ? new Date(end) : new Date(),
                    description: event.description ?? null,
                    location: event.location ?? null,
                    organizerEmail: event.organizer?.email ?? null,
                    attendees: event.attendees ?? null,
                    status: event.status ?? null,
                    htmlLink: event.htmlLink ?? null,
                    updatedAtGoogle: event.updated ? new Date(event.updated) : null,
                  })
                  .onConflictDoUpdate({
                    // (userId, eventId) — see the note on the model. Keyed on
                    // eventId alone this overwrote another attendee's row.
                    target: [calendarEvents.userId, calendarEvents.eventId],
                    set: {
                      title: event.summary ?? "(No title)",
                      startTime: start ? new Date(start) : new Date(),
                      endTime: end ? new Date(end) : new Date(),
                      description: event.description ?? null,
                      location: event.location ?? null,
                      organizerEmail: event.organizer?.email ?? null,
                      attendees: event.attendees ?? null,
                      status: event.status ?? null,
                      htmlLink: event.htmlLink ?? null,
                      updatedAtGoogle: event.updated ? new Date(event.updated) : null,
                      updatedAt: new Date(),
                    },
                  });
                logger.debug("[WEBHOOK] calendar event upserted", {
                  tenantId: activeTenantId,
                  eventId: event.id,
                });
              }
            } else if (data.type === "eventDeleted" && data.eventId) {
              // Scoped to this tenant: the same event id exists in every
              // attendee's calendar, so an unscoped delete removed their rows
              // too on a deletion that only concerned this user.
              await db
                .delete(calendarEvents)
                .where(
                  and(
                    eq(calendarEvents.userId, activeTenantId),
                    eq(calendarEvents.eventId, data.eventId),
                  ),
                );
              logger.debug("[WEBHOOK] calendar event deleted", {
                tenantId: activeTenantId,
                eventId: data.eventId,
              });
            }

            // Recovery/fallback path to make sure no updates are missed
            await syncCalendarEvents(activeTenantId);
          } catch (err) {
            logger.error("[WEBHOOK] calendar event sync failed", {
              tenantId: activeTenantId,
              ...errorFields(err),
            });
          }
        })();
      }
    }
  }

  return result;
}

