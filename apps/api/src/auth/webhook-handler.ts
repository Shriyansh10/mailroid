import { corsair } from "@repo/corsair";
import { processWebhook } from "corsair";
import { db, eq, and } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { ingestMessage } from "@repo/services/gmail/index.js";

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
    bodyPreview: JSON.stringify(req.body).slice(0, 200),
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
    { tenantId },
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

        if (lastHistoryId === incomingHistoryId) {
          console.log(`[webhook] Incoming historyId "${incomingHistoryId}" matches last stored historyId. Skipping.`);
          return;
        }

        const tenantClient = corsair.withTenant(tenantId);
        const accessToken = await tenantClient.gmail.keys.get_access_token();
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
          console.error("[webhook] Error fetching history list:", err);
          hasError = true;
        }

        if (hasError) {
          console.warn(`[webhook] Resetting historyId to incoming: "${incomingHistoryId}"`);
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

        if (addedMessageIds.size > 0) {
          console.log(`[webhook] Found ${addedMessageIds.size} new message(s) via History API:`, Array.from(addedMessageIds));
          for (const messageId of addedMessageIds) {
            console.log(`[webhook] Triggering ingestMessage for tenant "${tenantId}", message "${messageId}"`);
            void ingestMessage(tenantId, messageId, true).catch((err) => {
              console.error("[webhook] Failed to ingest message:", err);
            });
          }
        } else {
          console.log(`[webhook] No new messages added since historyId "${lastHistoryId}".`);
        }

        // Update stored mapping with the latest historyId
        if (mapping && incomingHistoryId !== lastHistoryId) {
          await db
            .update(gmailTenantMappings)
            .set({
              lastHistoryId: incomingHistoryId,
            })
            .where(eq(gmailTenantMappings.emailAddress, mapping.emailAddress));
          console.log(`[webhook] Updated stored historyId for tenant "${tenantId}" to "${incomingHistoryId}"`);
        }
      } catch (err) {
        console.error("[webhook] Async sync process failed:", err);
      }
    })();
  }

  return result;
}

