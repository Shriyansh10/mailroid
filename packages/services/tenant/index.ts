import { corsairInstanceIdEnv, googleClientKeysEnv } from '../env.js'
import { corsairClient,corsair } from "@repo/corsair";
import { type EnsureTenantInputType, ensureTenantInput,type AuthorizePluginsInputType, type AuthorizePluginsOutputType, authorizePluginsInput, authorizePluginsOutput} from "./model.js";
import { setupCorsair } from "corsair";

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