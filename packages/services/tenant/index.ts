import { corsairInstanceIdEnv, googleClientKeysEnv } from '../env.js'
import { corsairClient,corsair } from "@repo/corsair";
import { type EnsureTenantInputType, ensureTenantInput,type AuthorizePluginsInputType, type AuthorizePluginsOutputType, authorizePluginsInput, type GetGmailOAuthUrlOutput, type GetCalendarOAuthUrlOutput, type ConnectedPluginsOutput, type ConnectedAccountsOutput, type GetAccountsExistOutput } from "./model.js";
import { setupCorsair } from "corsair";
import { generateOAuthUrl, processOAuthCallback } from "corsair/oauth";
import { db, eq } from "@repo/database";
import { corsairConnectionEmails } from "@repo/database/models/corsair-connections";
import { corsairAccounts, corsairIntegrations } from "@repo/database/models/corsair";

export async function ensureTenant({userId}: EnsureTenantInputType) {
    const { userId:parseduserId } = await ensureTenantInput.parseAsync({ userId });
     await setupCorsair(corsair, {
    tenantId: parseduserId,
  });
  const inst = corsairClient.instance(
    corsairInstanceIdEnv.CORSAIR_INSTANCE_ID as string,
  );
  await inst.runtime.refresh();

console.log('after refresh: ', await inst.runtime.status());

  try {
  const tenant = await inst.tenant(parseduserId).get();
  console.log("Tenant already exists");
  return tenant;
} catch {
  console.log("Creating tenant");
  return await inst.tenants.create(parseduserId);
}
}

export async function authorizePlugins({
  userId,
}: AuthorizePluginsInputType): Promise<AuthorizePluginsOutputType> {

    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = googleClientKeysEnv;
  // ── 1. Validate input ──────────────────────────────────────────────
  const { userId: parsedUserId } =
    await authorizePluginsInput.parseAsync({ userId });


  // ── 2. Get the Corsair HTTP API client instance ────────────────────
  const inst = corsairClient.instance(corsairInstanceIdEnv.CORSAIR_INSTANCE_ID as string);

  await ensureTenant({ userId: parsedUserId });

  // ── 3. Set root-level Google OAuth credentials ─────────────────────
  // Corsair uses these to provision per-tenant OAuth tokens.
  // Each tenant's tokens are encrypted with their own DEK.

  await pluginSetRoot(inst, "gmail", "client_id", GOOGLE_CLIENT_ID as string);
  await pluginSetRoot(inst, "gmail", "client_secret", GOOGLE_CLIENT_SECRET as string);
  await pluginSetRoot(inst, "googlecalendar", "client_id", GOOGLE_CLIENT_ID as string);
  await pluginSetRoot(inst, "googlecalendar", "client_secret", GOOGLE_CLIENT_SECRET as string);

  
  // ── 4. Generate the Connect Link ───────────────────────────────────
  const tenant = inst.tenant(parsedUserId);

  const { url } = await tenant.connectLink.create({
    plugins: ["gmail", "googlecalendar"],
  });

  return { url };
}

const pluginSetRoot = async (tenant: any, pluginName: string, key: string, value: string) => {
    await tenant.plugins.credentials.setRoot(pluginName, key, value);
}

/**
 * Generates a Gmail OAuth authorization URL using the Corsair SDK.
 *
 * Unlike `authorizePlugins` (which uses Corsair App's connectLink.create),
 * this uses the SDK's `generateOAuthUrl` — when the callback processes the
 * code, tokens are stored directly in your local database (same as CLI flow).
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
    "http://localhost:8000/api/auth/gmail-callback";

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
    "http://localhost:8000/api/auth/calendar-callback";

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
    const tenant = corsair.withTenant(userId);

    // The Corsair-wrapped Gmail token doesn't work with userinfo.
    // Use the Gmail API's native getProfile instead.
    const profile = await tenant.gmail.api.users.getProfile({ userId: "me" });
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

    console.log("[storeGmailConnectedEmail] ✅ stored:", email);
    return email;
  } catch (err) {
    console.error("[storeGmailConnectedEmail] ❌ FAILED:", err);
    return null;
  }
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
    const calendarList = await tenant.googlecalendar.api.calendarList.list();
    console.log("[storeCalendarConnectedEmail] list:", JSON.stringify(calendarList));

    const primaryCalendar = calendarList.items?.find(
      (c: { primary?: boolean; id?: string }) => c.primary,
    );
    const email = primaryCalendar?.id ?? null;

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

  return {
    gmail: names.has("gmail"),
    calendar: names.has("googlecalendar"),
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