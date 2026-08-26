import { corsair } from "@repo/corsair";
import { type EnsureTenantInputType, ensureTenantInput,type AuthorizePluginsInputType, type AuthorizePluginsOutputType, authorizePluginsInput, type GetGmailOAuthUrlOutput, type GetCalendarOAuthUrlOutput, type ConnectedPluginsOutput, type ConnectedAccountsOutput, type GetAccountsExistOutput } from "./model.ts";
import { setupCorsair } from "corsair";
import { generateOAuthUrl, processOAuthCallback } from "corsair/oauth";
import { and, db, eq, inArray } from "@repo/database";
import { corsairConnectionEmails } from "@repo/database/models/corsair-connections";
import { corsairAccounts, corsairEntities, corsairEvents, corsairIntegrations } from "@repo/database/models/corsair";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { gmailRequestWithAuthRecovery } from "../gmail/gmail-request.ts";

export async function ensureTenant({userId}: EnsureTenantInputType) {
    const { userId: parseduserId } = await ensureTenantInput.parseAsync({ userId });
    await setupCorsair(corsair, {
        tenantId: parseduserId,
    });
    console.log("Tenant ensured for user:", parseduserId);
    return { tenantId: parseduserId };
}

export async function authorizePlugins({
  userId,
}: AuthorizePluginsInputType): Promise<AuthorizePluginsOutputType> {

  // ── 1. Validate input ──────────────────────────────────────────────
  const { userId: parsedUserId } =
    await authorizePluginsInput.parseAsync({ userId });

  // ── 2. Ensure tenant exists locally (SDK) ──────────────────────────
  await ensureTenant({ userId: parsedUserId });

  // ── 3. Generate Gmail OAuth URL via SDK (local OAuth flow) ─────────
  // Tokens are stored encrypted in the local database on callback.
  const callbackUrl = process.env.GMAIL_OAUTH_CALLBACK_URL ??
    (process.env.BASE_URL ? `${process.env.BASE_URL}/api/auth/gmail-callback` : "http://localhost:8000/api/auth/gmail-callback");

  const { url } = await generateOAuthUrl(corsair, "gmail", {
    tenantId: parsedUserId,
    redirectUri: callbackUrl,
  });

  return { url };
}

/**
 * Generates a Gmail OAuth authorization URL using the Corsair SDK.
 *
 * When the callback processes the code, tokens are stored encrypted
 * in your local database.
 *
 * The caller should:
 *   1. Redirect the user to `url`
 *   2. Store `state` in an httpOnly cookie
 *   3. On callback, verify `state` matches, then call `processOAuthCallback`
 *
 * @param userId - The user's ID (tenant ID).
 * @returns { url, state } — redirect URL and HMAC-signed state parameter.
 */
export async function getGmailOAuthUrl(userId: string): Promise<GetGmailOAuthUrlOutput> {
  const callbackUrl = process.env.GMAIL_OAUTH_CALLBACK_URL ?? 
    (process.env.BASE_URL ? `${process.env.BASE_URL}/api/auth/gmail-callback` : "http://localhost:8000/api/auth/gmail-callback");

  const { url, state } = await generateOAuthUrl(corsair, "gmail", {
    tenantId: userId,
    redirectUri: callbackUrl,
  });

  return { url, state };
}

/**
 * Generates a Calendar OAuth authorization URL using the Corsair SDK.
 *
 * @param userId - The user's ID (tenant ID).
 * @returns { url, state } — redirect URL and HMAC-signed state parameter.
 */
export async function getCalendarOAuthUrl(userId: string): Promise<GetCalendarOAuthUrlOutput> {
  const callbackUrl =
    process.env.CALENDAR_OAUTH_CALLBACK_URL ??
    (process.env.BASE_URL ? `${process.env.BASE_URL}/api/auth/calendar-callback` : "http://localhost:8000/api/auth/calendar-callback");

  const { url, state } = await generateOAuthUrl(corsair, "googlecalendar", {
    tenantId: userId,
    redirectUri: callbackUrl,
  });

  return { url, state };
}

/**
 * Shared helper — exchanges the OAuth code for any plugin and stores tokens
 * encrypted in the local database.
 */
export async function processOAuthCallbackForPlugin(
  code: string,
  state: string,
  callbackUrl: string,
): Promise<{ plugin: string; tenantId: string }> {
  return processOAuthCallback(corsair, { code, state, redirectUri: callbackUrl });
}

/**
 * Checks which plugins have valid OAuth tokens for the given tenant.
 */
export async function getConnectedPlugins(userId: string): Promise<ConnectedPluginsOutput> {
  const tenant = corsair.withTenant(userId);

  const [gmailToken, calendarToken] = await Promise.all([
    tenant.gmail.keys.get_access_token().catch(() => null),
    tenant.googlecalendar.keys.get_access_token().catch(() => null),
  ]);

  return {
    gmail: gmailToken !== null,
    googlecalendar: calendarToken !== null,
  };
}

/**
 * After Gmail OAuth succeeds, fetch the connected Google account email
 * and persist it in the database.
 */
export async function storeGmailConnectedEmail(userId: string): Promise<string | null> {
  console.log("[storeGmailConnectedEmail] START userId:", userId);
  try {
    // Fourth of the four sites that paired keys.get_access_token() with a raw
    // fetch. That pairing never refreshes, so it 401s on any stored token older
    // than an hour — see gmail-request.ts for the incident this caused.
    const response = await gmailRequestWithAuthRecovery(
      userId,
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { ctx: { trigger: "oauth-callback", operation: "users.getProfile", targetId: userId } },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch Gmail profile: ${response.statusText}`);
    }

    const profile = await response.json() as { emailAddress?: string };
    console.log("[storeGmailConnectedEmail] profile:", JSON.stringify(profile));

    const email = profile.emailAddress;
    if (!email) {
      console.log("[storeGmailConnectedEmail] ❌ no email in profile");
      return null;
    }

    await db
      .insert(corsairConnectionEmails)
      .values({ userId, gmailEmail: email })
      .onConflictDoUpdate({
        target: corsairConnectionEmails.userId,
        set: { gmailEmail: email, updatedAt: new Date() },
      });

    await db
      .insert(gmailTenantMappings)
      .values({ emailAddress: email, tenantId: userId })
      .onConflictDoUpdate({
        target: gmailTenantMappings.emailAddress,
        set: { tenantId: userId, updatedAt: new Date() },
      });

    console.log("[storeGmailConnectedEmail] ✅ stored:", email);
    return email;
  } catch (err) {
    // DO NOT SWALLOW. This used to `return null`, and the caller had no way to
    // tell "no address in the profile" from "Google refused the call" — so a
    // transient 429 here produced a tenant with a stored OAuth token, no
    // gmail_tenant_mappings row, and a UI that said "Connected ✓" because
    // getAccountsExist only ever looked at corsair_accounts.
    //
    // That state could not self-heal: both bootstrapGmailWatches and
    // gmailWatchCron pick their candidates FROM gmail_tenant_mappings, so a
    // mailbox with no row is invisible to every retry path in the system.
    // It stayed broken until someone reconnected by hand.
    console.error("[storeGmailConnectedEmail] ❌ FAILED:", err);
    throw err;
  }
}

/**
 * Undo a partial Gmail connection.
 *
 * processOAuthCallbackForPlugin writes the corsair account (the encrypted
 * token) before anything else runs, so a later failure leaves that row behind
 * on its own. getAccountsExist reads exactly that row, which is what made a
 * failed connect present as a successful one.
 *
 * Deletes children first: corsair_entities and corsair_events reference
 * corsair_accounts with NO ACTION, not CASCADE, so the parent delete errors out
 * if they are still present. On a fresh connect there are none — the sync has
 * not run yet — but this is also reachable from a reconnect over an account
 * that already synced.
 */
export async function rollbackGmailConnection(userId: string): Promise<void> {
  const accounts = await db
    .select({ id: corsairAccounts.id })
    .from(corsairAccounts)
    .innerJoin(corsairIntegrations, eq(corsairAccounts.integrationId, corsairIntegrations.id))
    .where(and(eq(corsairAccounts.tenantId, userId), eq(corsairIntegrations.name, "gmail")));

  if (accounts.length === 0) return;

  const ids = accounts.map((a) => a.id);

  await db.delete(corsairEvents).where(inArray(corsairEvents.accountId, ids));
  await db.delete(corsairEntities).where(inArray(corsairEntities.accountId, ids));
  await db.delete(corsairAccounts).where(inArray(corsairAccounts.id, ids));

  // The mapping/email rows are only written on the success path, but a
  // reconnect over an existing connection may have refreshed them already.
  await db.delete(gmailTenantMappings).where(eq(gmailTenantMappings.tenantId, userId));
  await db
    .update(corsairConnectionEmails)
    .set({ gmailEmail: null, updatedAt: new Date() })
    .where(eq(corsairConnectionEmails.userId, userId));

  console.log("[rollbackGmailConnection] rolled back partial Gmail connection for", userId);
}

/**
 * After Calendar OAuth succeeds, fetch the connected Google account email.
 *
 * Uses the Calendar API's calendarList to get the primary calendar ID,
 * which is the user's email address.
 */
export async function storeCalendarConnectedEmail(userId: string): Promise<string | null> {
  console.log("[storeCalendarConnectedEmail] START userId:", userId);
  try {
    const tenant = corsair.withTenant(userId);

    // Call a dummy method first to trigger token refresh if needed
    try {
      await tenant.googlecalendar.api.events.getMany({ maxResults: 1 });
    } catch (e) {
      console.warn("[storeCalendarConnectedEmail] Token refresh dummy call warning:", e);
    }

    const accessToken = await tenant.googlecalendar.keys.get_access_token();
    if (!accessToken) {
      console.error("[storeCalendarConnectedEmail] ❌ No access token available");
      return null;
    }

    const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[storeCalendarConnectedEmail] ❌ Failed to fetch primary calendar:", errorText);
      return null;
    }

    const primaryCalendar = await response.json() as { id?: string };
    const email = primaryCalendar.id ?? null;

    if (!email) {
      console.log("[storeCalendarConnectedEmail] ❌ no primary calendar found");
      return null;
    }

    await db
      .insert(corsairConnectionEmails)
      .values({ userId, calendarEmail: email })
      .onConflictDoUpdate({
        target: corsairConnectionEmails.userId,
        set: { calendarEmail: email, updatedAt: new Date() },
      });

    await db
      .insert(calendarTenantMappings)
      .values({ emailAddress: email, tenantId: userId })
      .onConflictDoUpdate({
        target: calendarTenantMappings.emailAddress,
        set: { tenantId: userId, updatedAt: new Date() },
      });

    console.log("[storeCalendarConnectedEmail] ✅ stored:", email);
    return email;
  } catch (err) {
    console.error("[storeCalendarConnectedEmail] ❌ FAILED:", err);
    return null;
  }
}

/**
 * Returns the full connected-account snapshot used by the onboarding page.
 *
 * Includes:
 *  - The BetterAuth login email
 *  - The Gmail-connected email (if any)
 *  - The Calendar-connected email (if any)
 *  - Boolean flags for token presence
 */
export async function getConnectedAccounts(
  userId: string,
  betterAuthEmail: string,
): Promise<ConnectedAccountsOutput> {
  const plugins = await getConnectedPlugins(userId);

  const [row] = await db
    .select({
      gmailEmail: corsairConnectionEmails.gmailEmail,
      calendarEmail: corsairConnectionEmails.calendarEmail,
    })
    .from(corsairConnectionEmails)
    .where(eq(corsairConnectionEmails.userId, userId));

  return {
    betterAuthEmail,
    gmailEmail: row?.gmailEmail ?? null,
    calendarEmail: row?.calendarEmail ?? null,
    gmailConnected: plugins.gmail,
    calendarConnected: plugins.googlecalendar,
  };
}

/**
 * Checks corsair_accounts + corsair_integrations directly (no SDK, no token checks)
 * to determine if Gmail and/or Calendar accounts exist for this tenant.
 */
export async function getAccountsExist(userId: string): Promise<GetAccountsExistOutput> {
  const rows = await db
    .select({ name: corsairIntegrations.name })
    .from(corsairAccounts)
    .innerJoin(corsairIntegrations, eq(corsairAccounts.integrationId, corsairIntegrations.id))
    .where(eq(corsairAccounts.tenantId, userId));

  const names = new Set(rows.map((r) => r.name));

  // A stored OAuth token is NOT a working connection. corsair_accounts is
  // written first in the callback, so on its own it goes true the moment the
  // token lands — before the mailbox is mapped and before the watch exists.
  // Reporting that as "connected" is what put a green tick above a mailbox the
  // rest of the system could not see: no gmail_tenant_mappings row means no
  // webhook can resolve a tenant and no watch cron can find it to renew.
  //
  // The mapping row is the honest signal, so require both. This also repairs
  // accounts already stranded in the half-connected state — they flip back to
  // false and the UI offers Connect again, rather than insisting they are fine.
  const [gmailMapping] = await db
    .select({ tenantId: gmailTenantMappings.tenantId })
    .from(gmailTenantMappings)
    .where(eq(gmailTenantMappings.tenantId, userId))
    .limit(1);

  const [calendarMapping] = await db
    .select({ tenantId: calendarTenantMappings.tenantId })
    .from(calendarTenantMappings)
    .where(eq(calendarTenantMappings.tenantId, userId))
    .limit(1);

  return {
    gmail: names.has("gmail") && Boolean(gmailMapping),
    calendar: names.has("googlecalendar") && Boolean(calendarMapping),
  };
}

/**
 * Clears a specific connection email so the user can reconnect.
 */
export async function clearConnectionEmail(
  userId: string,
  plugin: "gmail" | "googlecalendar",
): Promise<void> {
  const field = plugin === "gmail"
    ? { gmailEmail: null as string | null }
    : { calendarEmail: null as string | null };

  await db
    .update(corsairConnectionEmails)
    .set({ ...field, updatedAt: new Date() })
    .where(eq(corsairConnectionEmails.userId, userId));
}