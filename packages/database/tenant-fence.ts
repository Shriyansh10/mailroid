import { eq } from "drizzle-orm";

import { db } from "./index.ts";
import { tenantEpoch } from "./models/account-deletion.ts";

/**
 * Is this tenant fenced for account deletion?
 *
 * Read by the Better Auth hooks in both apps so a fenced user is refused a new
 * session with a plain message, rather than meeting the database trigger's
 * TENANT_FENCED error halfway through sign-in. The trigger stays the actual
 * guarantee; this is the readable front of it. No row means never fenced.
 */
export async function isTenantFenced(tenantId: string): Promise<boolean> {
  const [row] = await db
    .select({ state: tenantEpoch.state })
    .from(tenantEpoch)
    .where(eq(tenantEpoch.tenantId, tenantId))
    .limit(1);
  return row?.state === "FENCED";
}

export const FENCED_SIGN_IN_MESSAGE =
  "This account is being deleted and can no longer be signed in to. Contact support if this is a mistake.";
