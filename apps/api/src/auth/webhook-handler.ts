import { corsair } from "@repo/corsair";
import { processWebhook } from "corsair";
import { db, eq, and } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { calendarEvents } from "@repo/database/models/calendar-events";
import { ingestMessage } from "@repo/services/gmail/index.js";
import { syncCalendarEvents } from "@repo/services/calendar/sync-events.js";
import { describeError } from "../diagnostics/describe-error.js";

/**
 * Gmail historyIds are monotonically increasing uint64 values delivered as
 * strings. Pub/Sub gives no ordering or exactly-once guarantee, so a stale
 * notification can arrive *after* a newer one — comparing with `!==` instead of
 * an ordered compare is what let the stored cursor regress to an older value,
 * which in turn made every subsequent notification re-fetch and re-ingest the
 * same history window forever.
 *
 * Parsed as BigInt rather than Number: historyIds are uint64 and would silently
 * lose precision past 2^53.
 *
 * Returns null when the value is absent or not a valid non-negative integer, so
 * callers can fall back rather than throw on unexpected input.
 */
function parseHistoryId(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

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
      console.warn(`[webhook] Calendar push notification received but no tenant mapping found for channelId: "${channelId}"`);
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

    // We run the history-based sync inside an asynchronous promise so the webhook returns immediately to the sender
    void (async () => {
      try {
        const [mapping] = await db
          .select({
            emailAddress: gmailTenantMappings.emailAddress,
            lastHistoryId: gmailTenantMappings.lastHistoryId,
          })
          .from(gmailTenantMappings)
          .where(eq(gmailTenantMappings.tenantId, tenantId))
          .limit(1);

        const lastHistoryId = mapping?.lastHistoryId;

        if (!lastHistoryId) {
          console.log(`[webhook] No previous historyId stored for tenant "${tenantId}". Initializing lastHistoryId to "${incomingHistoryId}".`);
          if (mapping) {
            await db
              .update(gmailTenantMappings)
              .set({
                lastHistoryId: incomingHistoryId,
              })
              .where(eq(gmailTenantMappings.emailAddress, mapping.emailAddress));
          }
          return;
        }

        const lastParsed = parseHistoryId(lastHistoryId);
        const incomingParsed = parseHistoryId(incomingHistoryId);

        // Drop notifications that are not strictly newer than the cursor.
        // Pub/Sub redelivers and does not preserve order, so this covers both
        // exact duplicates and genuinely stale deliveries. The previous `!==`
        // check only caught duplicates, so a stale id fell through, fetched an
        // empty window, and then reset the cursor backwards to itself — leaving
        // two ids to ping-pong forever, re-ingesting the same messages on every
        // swing.
        if (lastParsed !== null && incomingParsed !== null && incomingParsed <= lastParsed) {
          console.log(
            `[webhook] Incoming historyId "${incomingHistoryId}" is not newer than stored "${lastHistoryId}". Skipping stale notification.`,
          );
          return;
        }

        // Unparseable ids should not silently disable the guard above.
        if (lastParsed === null || incomingParsed === null) {
          console.warn(
            `[webhook] Non-numeric historyId (stored: "${lastHistoryId}", incoming: "${incomingHistoryId}") — falling back to equality check.`,
          );
          if (lastHistoryId === incomingHistoryId) {
            console.log(`[webhook] Incoming historyId "${incomingHistoryId}" matches last stored historyId. Skipping.`);
            return;
          }
        }

        const tenantClient = corsair.withTenant(tenantId);

        // keys.get_access_token() decrypts the account DEK with CORSAIR_KEK
        // (scrypt + AES-256-GCM) and then the stored token. It does NOT refresh
        // — refresh only happens via the plugin's keyBuilder on an SDK api.*
        // call. So a throw here is a *decryption* problem (wrong KEK =>
        // "Unsupported state or unable to authenticate data"), whereas a throw
        // during ingestMessage is a *refresh/network* problem. Separating the
        // two is the whole point of logging them distinctly.
        let accessToken: string | null;
        try {
          accessToken = await tenantClient.gmail.keys.get_access_token();
        } catch (err) {
          console.error(
            `[webhook] Gmail credential decrypt FAILED for tenant "${tenantId}" (KEK/DEK problem, not network):`,
            JSON.stringify(describeError(err)),
          );
          return;
        }

        if (!accessToken) {
          console.error(`[webhook] Failed to get Gmail access token for tenant "${tenantId}"`);
          return;
        }

        const addedMessageIds = new Set<string>();
        let nextPageToken: string | undefined = undefined;
        let hasError = false;

        try {
          do {
            let url = `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${lastHistoryId}`;
            if (nextPageToken) {
              url += `&pageToken=${nextPageToken}`;
            }

            console.log(`[webhook] Fetching Gmail history since ${lastHistoryId}...`);
            const response = await fetch(url, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            });

            if (!response.ok) {
              const errorText = await response.text();
              console.warn(`[webhook] Gmail history fetch failed: ${response.status} - ${errorText}`);
              hasError = true;
              break;
            }

            const data = await response.json() as {
              history?: Array<{
                messagesAdded?: Array<{
                  message?: {
                    id?: string;
                  };
                }>;
                labelsAdded?: Array<{
                  message?: {
                    id?: string;
                  };
                }>;
              }>;
              nextPageToken?: string;
            };

            console.log(
              "[webhook] HISTORY RESPONSE",
              JSON.stringify(data, null, 2)
            );

            if (data.history && data.history.length > 0) {
              for (const record of data.history) {
                // Extract from messagesAdded
                if (record.messagesAdded) {
                  for (const added of record.messagesAdded) {
                    if (added.message?.id) {
                      addedMessageIds.add(added.message.id);
                    }
                  }
                }
                // Extract from labelsAdded (e.g. INBOX label additions)
                if (record.labelsAdded) {
                  for (const labelRecord of record.labelsAdded) {
                    if (labelRecord.message?.id) {
                      addedMessageIds.add(labelRecord.message.id);
                    }
                  }
                }
              }
            } else {
              console.log(
                `[webhook] history[] is empty. startHistoryId: ${lastHistoryId}, incomingHistoryId: ${incomingHistoryId}, nextPageToken: ${nextPageToken || "none"}`
              );
            }

            nextPageToken = data.nextPageToken;
          } while (nextPageToken);
        } catch (err) {
          // describeError unwraps err.cause — without it undici reports only
          // "fetch failed" and the real errno (ENETUNREACH/ETIMEDOUT/EAI_AGAIN)
          // plus the address actually dialed are lost.
          console.error(
            "[webhook] Error fetching history list:",
            JSON.stringify(describeError(err)),
          );
          hasError = true;
        }

        if (hasError) {
          // Only ever skip *forward* on error. Writing the incoming id
          // unconditionally would regress the cursor whenever a stale
          // notification happened to fail, re-opening the ping-pong this fix
          // exists to close.
          if (mapping && (lastParsed === null || incomingParsed === null || incomingParsed > lastParsed)) {
            console.warn(`[webhook] Resetting historyId to incoming: "${incomingHistoryId}"`);
            await db
              .update(gmailTenantMappings)
              .set({
                lastHistoryId: incomingHistoryId,
              })
              .where(eq(gmailTenantMappings.emailAddress, mapping.emailAddress));
          } else {
            console.warn(
              `[webhook] Fetch failed for stale historyId "${incomingHistoryId}"; keeping stored "${lastHistoryId}".`,
            );
          }
          return;
        }

        if (addedMessageIds.size > 0) {
          console.log(`[webhook] Found ${addedMessageIds.size} new message(s) via History API:`, Array.from(addedMessageIds));
          for (const messageId of addedMessageIds) {
            console.log(`[webhook] Triggering ingestMessage for tenant "${tenantId}", message "${messageId}"`);
            void ingestMessage(tenantId, messageId, true).catch((err) => {
              // This is the path that reaches Corsair's keyBuilder -> token
              // refresh against oauth2.googleapis.com, so "[corsair:gmail]
              // Failed to obtain valid access token: fetch failed" surfaces
              // here. The wrapped Error drops the cause, so log both the
              // message and any chain we can still recover.
              console.error(
                `[webhook] Failed to ingest message "${messageId}" for tenant "${tenantId}":`,
                JSON.stringify(describeError(err)),
              );
            });
          }
        } else {
          console.log(`[webhook] No new messages added since historyId "${lastHistoryId}".`);
        }

        // Advance the stored cursor — forward only. The previous `!==` check
        // wrote whatever arrived last, so an out-of-order delivery moved the
        // cursor backwards and the next notification re-fetched an already
        // -ingested window. Guarding on `>` makes the cursor monotonic, which is
        // what Gmail's historyId semantics already assume.
        if (mapping && (lastParsed === null || incomingParsed === null || incomingParsed > lastParsed)) {
          await db
            .update(gmailTenantMappings)
            .set({
              lastHistoryId: incomingHistoryId,
            })
            .where(eq(gmailTenantMappings.emailAddress, mapping.emailAddress));
          console.log(`[webhook] Updated stored historyId for tenant "${tenantId}" to "${incomingHistoryId}"`);
        }
      } catch (err) {
        console.error(
          "[webhook] Async sync process failed:",
          JSON.stringify(describeError(err)),
        );
      }
    })();
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

