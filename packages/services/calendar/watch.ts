import crypto from "node:crypto";
import { corsair } from "@repo/corsair";
import { db, eq, desc } from "@repo/database";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { corsairConnectionEmails } from "@repo/database/models/corsair-connections";

// Re-register a calendar watch only once it's within this window of expiring.
// A healthy watch further out than this is left alone (idempotent renewals) so
// we don't spawn a fresh channel — and orphan the old one — on every call.
const RENEW_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000; // 48h

/**
 * Best-effort stop of a Google Calendar watch channel. Calendar keeps pushing
 * to every live channel until it expires (~7 days), so a channel we've replaced
 * but never stopped becomes an orphan that spams the webhook with pushes we
 * can no longer map to a tenant. Always stop the old channel before minting a
 * new one, and use this from the one-time orphan cleanup too.
 *
 * Never throws: a failed stop must not block registering the new watch. Google
 * returns 204 on success and 404 if the channel already expired/gone — both are
 * "fine, it's not delivering anymore".
 */
export async function stopCalendarChannel(
  accessToken: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  try {
    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/channels/stop",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: channelId, resourceId }),
      },
    );
    if (res.ok || res.status === 404) {
      console.log(`[calendar-watch] Stopped old channel ${channelId} (status ${res.status})`);
    } else {
      console.warn(
        `[calendar-watch] Failed to stop old channel ${channelId}: ${res.status} ${await res.text()}`,
      );
    }
  } catch (err) {
    console.warn(`[calendar-watch] Error stopping old channel ${channelId}:`, err);
  }
}

export async function startCalendarWatch(
  tenantId: string,
  opts?: { force?: boolean },
): Promise<void> {
  console.log('[calendar-watch] Starting watch setup for tenant:', tenantId);

  // 0. Idempotency: if a healthy watch already exists (channel present and not
  //    close to expiring), leave it alone. Re-registering would mint a new
  //    channel and orphan the current one. The renewal cron only calls us for
  //    watches that are expiring/absent, but direct callers (onboarding re-runs,
  //    manual triggers) hit this guard too.
  const [existing] = await db
    .select()
    .from(calendarTenantMappings)
    .where(eq(calendarTenantMappings.tenantId, tenantId))
    .orderBy(desc(calendarTenantMappings.watchExpiration))
    .limit(1);

  if (
    !opts?.force &&
    existing?.channelId &&
    existing.watchExpiration &&
    existing.watchExpiration.getTime() - Date.now() > RENEW_THRESHOLD_MS
  ) {
    console.log(
      `[calendar-watch] Healthy watch already exists for tenant ${tenantId} ` +
        `(channel ${existing.channelId}, expires ${existing.watchExpiration.toISOString()}); skipping re-registration.`,
    );
    return;
  }

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

  // 4. Stop the previous channel BEFORE creating a new one, so we never leave
  //    an orphan channel pushing to the webhook. Best-effort — see helper.
  if (existing?.channelId && existing?.resourceId) {
    await stopCalendarChannel(accessToken, existing.channelId, existing.resourceId);
  }

  // 5. Generate unique channel ID
  const channelId = crypto.randomUUID();
  const baseUrl = process.env.BASE_URL ?? "http://localhost:8000";
  const webhookUrl = `${baseUrl}/api/webhook`;

  console.log(`[calendar-watch] Registering watch channel ${channelId} for ${email} pointing to ${webhookUrl}`);

  // 6. POST to Google Calendar watch API
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

  // 7. Save channel metadata to database
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
