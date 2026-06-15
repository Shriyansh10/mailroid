import { corsairInstanceIdEnv, googleClientKeysEnv } from '../env.js'
import { corsairClient,corsair } from "@repo/corsair";
import { type EnsureTenantInputType, ensureTenantInput,type AuthorizePluginsInputType, type AuthorizePluginsOutputType, authorizePluginsInput, authorizePluginsOutput, type GetGmailOAuthUrlOutput} from "./model.js";
import { setupCorsair } from "corsair";
import { generateOAuthUrl, processOAuthCallback } from "corsair/oauth";

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
 * Processes the Gmail OAuth callback — exchanges the authorization code
 * for access/refresh tokens and stores them encrypted in the local database.
 *
 * This is the final step of the SDK OAuth flow. After this call:
 * - corsair_accounts.config will contain the encrypted tokens
 * - tenant.gmail.api.* calls will work with automatic token refresh
 *
 * @param code  - The authorization code from Google's redirect query string
 * @param state - The state parameter from Google's redirect query string
 * @returns { plugin, tenantId } — which plugin was authorized for which tenant
 */
export async function processGmailOAuthCallback(
  code: string,
  state: string,
): Promise<{ plugin: string; tenantId: string }> {
  const callbackUrl =
    process.env.GMAIL_OAUTH_CALLBACK_URL ??
    "http://localhost:8000/api/auth/gmail-callback";

  const result = await processOAuthCallback(corsair, {
    code,
    state,
    redirectUri: callbackUrl,
  });

  return result;
}