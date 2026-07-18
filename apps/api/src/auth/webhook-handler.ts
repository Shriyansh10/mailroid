import { corsair } from "@repo/corsair";
import { processWebhook } from "corsair";
import { inngest } from "@repo/inngest";
import { db, eq, and } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { calendarEvents } from "@repo/database/models/calendar-events";
import { syncHistoryForTenant } from "@repo/services/gmail/webhook-sync.js";
import { syncCalendarEvents } from "@repo/services/calendar/sync-events.js";
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
  console.log(`[webhook] Attempting to resolve tenantId for email: "${targetEmailLower}"`);

  try {
    const [mapping] = await db
      .select({ tenantId: gmailTenantMappings.tenantId })
      .from(gmailTenantMappings)
      .where(eq(gmailTenantMappings.emailAddress, targetEmailLower));

    if (mapping) {
      console.log(`[webhook] Lookup succeeded: Resolved email "${targetEmailLower}" to tenantId "${mapping.tenantId}"`);
      return mapping.tenantId;
    }

    console.warn(`[webhook] Lookup failed: No tenant mapping found for email "${targetEmailLower}"`);
  } catch (err) {
    console.error(`[webhook] Error during tenant resolution lookup for "${targetEmailLower}":`, err);
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
        console.log(`[webhook] Resolved calendar tenantId "${calendarTenantId}" for channelId "${channelId}"`);
      }
    } catch (err) {
      console.error("[webhook] Error looking up calendar tenant mapping by channelId:", err);
    }
  }

  // ── Handle Direct Google Calendar Webhook Push Notifications ────────
  const resourceState = req.headers["x-goog-resource-state"];
  if (typeof channelId === "string") {
    console.log(`[webhook] Received Google Calendar push notification: channelId=${channelId}, resourceState=${resourceState}`);
    
    if (calendarTenantId) {
      if (resourceState === "sync") {
        console.log(`[webhook] Channel sync handshake for channelId "${channelId}". Returning 200.`);
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

      console.log(`[webhook] Triggering syncCalendarEvents in the background for tenant "${calendarTenantId}"...`);
      void (async () => {
        try {
          await syncCalendarEvents(calendarTenantId);
          console.log(`[webhook] Successfully completed background calendar sync for tenant "${calendarTenantId}"`);
        } catch (err) {
          console.error(`[webhook] Background calendar sync failed for tenant "${calendarTenantId}":`, err);
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
      console.warn(`[webhook] Ignoring calendar push from unmapped/orphan channelId: "${channelId}" (acking 200)`);
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

  // Resolve tenantId and extract historyId from Gmail Pub/Sub webhook body
  if (req.body && typeof req.body === "object") {
    const body = req.body as Record<string, any>;
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
              console.log(`[webhook] Resolved tenantId "${tenantId}" for email "${email}"`);
            } else {
              console.warn(`[webhook] Could not resolve tenantId for email "${email}"`);
            }
          }
        }
      } catch (e) {
        console.error("[webhook] Failed to parse Pub/Sub message data:", e);
      }
    }
  }

  console.log("[webhook] incoming", {
    tenantId,
    bodyPreview: req.body ? JSON.stringify(req.body).slice(0, 200) : "",
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
    console.warn("[webhook] Ignoring gmail push for unmapped mailbox (acking 200)");
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

  const result = await processWebhook(
    corsair,
    Object.fromEntries(
      Object.entries(req.headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req.body as any,
    { tenantId: tenantId ?? calendarTenantId },
  );
  console.log(
    "[WEBHOOK FULL RESULT]",
    JSON.stringify(result, null, 2)
  );

  if (result.plugin) {
    console.log(`[webhook] ${result.plugin}.${result.action}`);
    console.log("[webhook] result content:", JSON.stringify(result, null, 2));
  }

  // Unified realtime email ingestion path via Gmail History API
  if (
    result.plugin === "gmail" &&
    result.action === "messageChanged" &&
    tenantId &&
    incomingHistoryId
  ) {
    console.log(`[webhook] [INGEST BLOCK REACHED] tenantId: ${tenantId}, incomingHistoryId: ${incomingHistoryId}`);

    if (WEBHOOK_VIA_INNGEST) {
      // Durable: an Inngest event send is itself reliable, and the function
      // it triggers (gmailWebhookSync) retries on failure and serializes
      // per-tenant. Returns to the Pub/Sub sender immediately either way.
      await inngest.send({
        name: "gmail/webhook.notification",
        data: { tenantId, incomingHistoryId },
      });
    } else {
      // Legacy path, kept for one release as the rollback for
      // WEBHOOK_VIA_INNGEST. Same fire-and-forget shape as before, but now
      // delegates to the shared syncHistoryForTenant so the ordering fix
      // (store before advancing the cursor) applies here too.
      void syncHistoryForTenant(tenantId, incomingHistoryId).catch((err) => {
        console.error(
          `[webhook] syncHistoryForTenant failed for tenant "${tenantId}":`,
          JSON.stringify(describeError(err)),
        );
      });
    }
  }

  // Google Calendar webhook sync logic
  if (result.plugin === "googlecalendar") {
    console.log("[CALENDAR WEBHOOK]", JSON.stringify(result, null, 2));

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
                    target: calendarEvents.eventId,
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
                console.log(`[webhook] Synced calendar event "${event.id}" in DB for tenant "${activeTenantId}"`);
              }
            } else if (data.type === "eventDeleted" && data.eventId) {
              await db
                .delete(calendarEvents)
                .where(eq(calendarEvents.eventId, data.eventId));
              console.log(`[webhook] Deleted calendar event "${data.eventId}" from DB for tenant "${activeTenantId}"`);
            }

            // Recovery/fallback path to make sure no updates are missed
            console.log(`[webhook] Triggering syncCalendarEvents fallback for tenant "${activeTenantId}"...`);
            await syncCalendarEvents(activeTenantId);
          } catch (err) {
            console.error("[webhook] Error syncing calendar event webhook data:", err);
          }
        })();
      }
    }
  }

  return result;
}

