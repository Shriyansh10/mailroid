import crypto from "node:crypto";
import { corsair } from "@repo/corsair";
import { db, eq } from "@repo/database";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { corsairConnectionEmails } from "@repo/database/models/corsair-connections";

export async function startCalendarWatch(tenantId: string): Promise<void> {
  console.log('[calendar-watch] Starting watch setup for tenant:', tenantId);
  const tenant = corsair.withTenant(tenantId);

  // 1. Force Corsair to refresh the token if it has expired by calling getMany
  try {
    console.log('[calendar-watch] Triggering token refresh call via events.getMany...');
    await tenant.googlecalendar.api.events.getMany({ maxResults: 1 });
  } catch (error) {
    console.error(`[calendar-watch] Failed to trigger token refresh for tenant ${tenantId}:`, error);
  }

  // 2. Retrieve fresh OAuth access token
  const accessToken = await tenant.googlecalendar.keys.get_access_token();
  if (!accessToken) {
    throw new Error(`[calendar-watch] No access token available for tenant ${tenantId}`);
  }

  // 3. Resolve the user's connected calendar email
  let [connection] = await db
    .select({ calendarEmail: corsairConnectionEmails.calendarEmail })
    .from(corsairConnectionEmails)
    .where(eq(corsairConnectionEmails.userId, tenantId))
    .limit(1);

  let email = connection?.calendarEmail;
  if (!email) {
    console.warn(`[calendar-watch] No calendar email cached in database for tenant ${tenantId}. Querying primary calendar...`);
    try {
      const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (res.ok) {
        const primaryCalendar = await res.json() as { id?: string };
        email = primaryCalendar.id;
      }
    } catch (err) {
      console.error(`[calendar-watch] Failed to retrieve primary calendar email dynamically:`, err);
    }
  }

  if (!email) {
    throw new Error(`[calendar-watch] Could not resolve calendar email for tenant ${tenantId}`);
  }

  // 4. Generate unique channel ID
  const channelId = crypto.randomUUID();
  const baseUrl = process.env.BASE_URL ?? "http://localhost:8000";
  const webhookUrl = `${baseUrl}/api/webhook`;

  console.log(`[calendar-watch] Registering watch channel ${channelId} for ${email} pointing to ${webhookUrl}`);

  // 5. POST to Google Calendar watch API
  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: webhookUrl,
      }),
    }
  );

  const body = await response.text();
  console.log("[calendar-watch] API response:", response.status, body);

  if (!response.ok) {
    throw new Error(`Failed to start Google Calendar watch: ${body}`);
  }

  // 6. Save channel metadata to database
  try {
    const data = JSON.parse(body) as {
      id?: string;
      resourceId?: string;
      expiration?: string;
    };

    const watchExpiration = data.expiration ? new Date(parseInt(data.expiration)) : null;

    await db
      .insert(calendarTenantMappings)
      .values({
        emailAddress: email,
        tenantId,
        channelId: data.id ?? channelId,
        resourceId: data.resourceId,
        watchExpiration,
      })
      .onConflictDoUpdate({
        target: calendarTenantMappings.emailAddress,
        set: {
          tenantId,
          channelId: data.id ?? channelId,
          resourceId: data.resourceId,
          watchExpiration,
          updatedAt: new Date(),
        },
      });

    console.log(`[calendar-watch] Successfully established and saved watch mapping for ${email}`);
  } catch (err) {
    console.error("[calendar-watch] Failed to parse watch response or save to database:", err);
    throw err;
  }
}
