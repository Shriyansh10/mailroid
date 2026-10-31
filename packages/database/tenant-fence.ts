import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "./index.ts";
import { hashEmail } from "./deletion-suppression.ts";
import { accountDeletionRequest, tenantEpoch } from "./models/account-deletion.ts";

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

/**
 * Statuses in which the purge has started but the deletion is not sealed: the
 * `user` row may already be gone, and the suppression marker — which is how a
 * returning Google account gets flagged for review — is only written at
 * COMPLETED. A sign-up in this window would create a fresh account that
 * nothing flags. INTEGRITY_INCIDENT is not here: it follows COMPLETED, so the
 * marker exists and a sign-up is flagged as usual.
 */
export const UNSEALED_DELETION_STATUSES = ["PURGING", "VERIFYING", "AWAITING_SEAL", "PURGE_FAILED"] as const;

/**
 * Is a deletion of this address in progress past the point where its user row
 * can be gone? Read by the Better Auth `user.create.before` hook in both apps:
 * an existing fenced user is refused at session creation instead, but once
 * the purge has removed the user row there is no session to refuse — the
 * callback would create a new user. Matches on the hash written at submit.
 */
export async function isDeletionUnsealed(email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accountDeletionRequest.id })
    .from(accountDeletionRequest)
    .where(
      and(
        eq(accountDeletionRequest.emailHash, hashEmail(email)),
        inArray(accountDeletionRequest.status, [...UNSEALED_DELETION_STATUSES]),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Is this sign-in's token refresh for a fenced user? Read by the Better Auth
 * `account.update.before` hook in both apps.
 *
 * A returning user's callback writes Google's fresh tokens to their `account`
 * row BEFORE it creates the session. For a fenced user the fence trigger
 * rejects that UPDATE — rightly: a fenced account must not take new tokens
 * after its grant was revoked — but as a raw database error, so sign-in failed
 * with a 500 instead of the deletion message. The hook is only handed the new
 * token fields, not the row, so the account is found from the `sub` in the
 * id_token Google just returned. No id_token, no answer: the trigger still
 * refuses the write.
 */
export async function isFencedGoogleSignIn(update: { idToken?: string | null }): Promise<boolean> {
  const sub = googleSubFromIdToken(update.idToken);
  if (!sub) return false;
  const res = await db.execute<{ fenced: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM "account" a JOIN tenant_epoch t ON t.tenant_id = a.user_id
       WHERE a.provider_id = 'google' AND a.account_id = ${sub} AND t.state = 'FENCED'
    ) AS fenced`);
  return res.rows[0]?.fenced === true;
}

function googleSubFromIdToken(idToken: string | null | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const sub = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    return null;
  }
}

/**
 * The code every deletion refusal carries out of the OAuth callback. Better
 * Auth redirects to `onAPIError.errorURL` (the sign-in page) with it as
 * `?error=`; the sign-in page turns it back into the sentence. The new-user
 * path can only carry a code (Better Auth passes the message itself through
 * as the code there, and drops anything that isn't [A-Za-z0-9_-]), so the code
 * is what the page keys on.
 */
export const FENCED_SIGN_IN_CODE = "ACCOUNT_BEING_DELETED";

export const FENCED_SIGN_IN_MESSAGE =
  "This account is being deleted and can no longer be signed in to. Contact support if this is a mistake.";
