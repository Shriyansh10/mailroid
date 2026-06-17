import { corsair } from "@repo/corsair";
import { db, eq } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";

const TOPIC_NAME = process.env.GMAIL_PUBSUB_TOPIC ?? "projects/mailroid-499113/topics/mailroid-webhooks";

export async function startGmailWatch(
  tenantId: string,
): Promise<void> {
  const tenant = corsair.withTenant(tenantId);

  // Trigger a lightweight API call to force Corsair to refresh the OAuth token if expired
  try {
    console.log('[gmail-watch] Triggering token refresh call via labels.list...');
    await tenant.gmail.api.labels.list();
  } catch (error) {
    console.error(`[gmail-watch] Failed to trigger token refresh for tenant ${tenantId}:`, error);
  }

  const accessToken =
    await tenant.gmail.keys.get_access_token();

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/watch",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topicName: TOPIC_NAME,
        labelIds: ["INBOX"],
      }),
    },
  );

  const body = await response.text();
  console.log("[gmail-watch]", response.status, body);

  if (!response.ok) {
    throw new Error(
      `Failed to start Gmail watch: ${body}`,
    );
  }

  try {
    const data = JSON.parse(body) as { expiration?: string; historyId?: string };
    const updateFields: Record<string, any> = {};

    if (data.expiration) {
      updateFields.watchExpiration = new Date(parseInt(data.expiration));
    }
    if (data.historyId) {
      updateFields.lastHistoryId = data.historyId;
    }

    if (Object.keys(updateFields).length > 0) {
      await db
        .update(gmailTenantMappings)
        .set(updateFields)
        .where(eq(gmailTenantMappings.tenantId, tenantId));
      console.log(`[gmail-watch] Successfully persisted watch state to database for tenant ${tenantId}`);
    }
  } catch (err) {
    console.error("[gmail-watch] Failed to parse response or save to database:", err);
  }
}