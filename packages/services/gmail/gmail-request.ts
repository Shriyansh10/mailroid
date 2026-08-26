/**
 * Every raw Gmail HTTP call in this codebase goes through here.
 *
 * IF YOU ARE ABOUT TO WRITE `keys.get_access_token()` + `fetch()`, YOU WANT
 * THIS FUNCTION INSTEAD. That pairing does NOT refresh the token — it only
 * decrypts whatever is stored — and it is what caused the 2026-08-25 cooldown
 * deadlock. It existed at four separate call sites before this file.
 *
 * WHY A RAW FETCH AT ALL. corsair's Gmail plugin exposes only messages /
 * threads / labels / drafts. `users.getProfile`, `users.history.list` and
 * `users.watch` have no endpoint, so they must be called directly — and a
 * direct call skips the keyBuilder, which is the only thing that refreshes.
 * This module puts the refresh back.
 *
 * WHAT IT IS NOT. Not "fetch Gmail". It is *a raw Gmail request with
 * corsair-managed token recovery*, and the 401 behaviour below is the whole
 * reason it exists. The name is long on purpose.
 *
 * NOTE THE IMPORTS THAT ARE DELIBERATELY ABSENT: withGmailRetry,
 * assertSyncAllowed, assertNotCoolingDown, assertNotPaused. See the invariant
 * on refreshTenantToken — gating this module recreates the deadlock.
 */

import { corsair } from "@repo/corsair";
import { logger } from "@repo/logger";

import { GmailAuthError, classifyGmailFailure } from "./gmail-errors.ts";
import type { GmailCallContext } from "./gmail-errors.ts";

/**
 * Test seam. Mirrors the `hooks` option on withGmailRetry (retry.ts) so this
 * module's behaviour can be asserted with no database, no network and no
 * corsair client — which matters especially for the "401 during an active
 * cooldown" case, the regression guard for the 2026-08-25 deadlock.
 */
export interface GmailRequestHooks {
  getAccessToken?: (tenantId: string) => Promise<string | null | undefined>;
  refreshToken?: (tenantId: string, ctx: GmailCallContext) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/**
 * Force corsair to refresh and re-persist this tenant's access token.
 *
 * MECHANISM (verified against @corsair-dev/gmail 0.1.4 and corsair 0.1.74).
 * corsair's endpoint wrapper awaits the keyBuilder to completion *before*
 * invoking the handler that issues the HTTP request:
 *
 *     let P; try { P = await keyBuilder(ctx, "endpoint") } catch ...
 *     await T(0, { ...ctx, key: P }, args)      // T reaches the handler
 *
 * and the Gmail keyBuilder refreshes (proactively at expiry-300s, or forced on
 * a 401) and writes the result back via set_access_token / set_expires_at. So
 * any api.* call refreshes, and the refresh lands before the request goes out.
 *
 * INVARIANT — THE POINT OF THIS WHOLE MODULE: this call must NEVER route
 * through withGmailRetry, assertSyncAllowed, assertAuthHealthy or
 * assertNotCoolingDown. Gating it recreates the exact deadlock this file exists
 * to remove:
 *
 *     cooldown → blocks refresh → token stays stale → 401 → cooldown
 *
 * This is ONE authentication-recovery operation, not normal Gmail traffic.
 * Quota cooldown may block normal Gmail work; it must never block the mechanism
 * required to recover authentication.
 *
 * labels.list is the cheapest endpoint available (1 quota unit) and its
 * response is discarded — only the keyBuilder side effect matters.
 */
async function refreshTenantToken(
  tenantId: string,
  ctx: GmailCallContext,
): Promise<void> {
  logger.info("[GMAIL_AUTH] refresh attempted", {
    tenantId,
    trigger: ctx.trigger,
    operation: ctx.operation,
    cause: "401-on-raw-fetch",
  });

  try {
    await corsair.withTenant(tenantId).gmail.api.labels.list();
  } catch (err) {
    // DO NOT SWALLOW INDISCRIMINATELY. Because the keyBuilder runs before the
    // HTTP request, the two cases are cleanly separable by *when* they can
    // possibly have occurred:
    //
    //   "auth"  → the REFRESH ITSELF failed (invalid_grant, revoked consent,
    //             missing client credentials). Nothing was persisted, the token
    //             is still stale, and retrying is pointless. Propagate so the
    //             caller records a real auth failure. Swallowing this is what
    //             would hide a revoked grant behind a generic "still 401".
    //
    //   anything → 429 / 5xx / transport. These can only have arrived AFTER
    //     else     the refresh completed and persisted, so the token IS fresh
    //              and the retry is worth making. A 429 here is expected: this
    //              runs on mailboxes Google is already refusing.
    if (classifyGmailFailure(err) === "auth") throw err;

    logger.debug("[GMAIL_AUTH] warm-up call refused after refresh", {
      tenantId,
      trigger: ctx.trigger,
      operation: ctx.operation,
      error: String((err as { message?: unknown } | null)?.message ?? err),
    });
  }
}

async function defaultGetAccessToken(tenantId: string): Promise<string | null | undefined> {
  return corsair.withTenant(tenantId).gmail.keys.get_access_token();
}

/**
 * Perform a raw Gmail request, recovering once from an expired access token.
 *
 * Healthy case: one token read, one fetch, ZERO extra Gmail calls — the
 * warm-up is 401-triggered only, which matters on webhook-sync's hot path and
 * on a mailbox we are deliberately trying not to call.
 *
 * Callers get the `Response` back untouched, including non-401 error statuses:
 * a 404 from users.history.list means "outside the retention window" and has a
 * real handler, so this must not turn it into a throw. Only unrecoverable
 * authentication throws.
 */
export async function gmailRequestWithAuthRecovery(
  tenantId: string,
  url: string,
  init: RequestInit & { ctx?: GmailCallContext; hooks?: GmailRequestHooks } = {},
): Promise<Response> {
  const { ctx = { trigger: "unknown" }, hooks, ...requestInit } = init;

  const getToken = hooks?.getAccessToken ?? defaultGetAccessToken;
  const refresh = hooks?.refreshToken ?? refreshTenantToken;
  const doFetch = hooks?.fetchImpl ?? fetch;

  const send = async (): Promise<Response> => {
    const token = await getToken(tenantId);
    if (!token) {
      throw new GmailAuthError(
        tenantId,
        `No Gmail access token stored for tenant ${tenantId}`,
      );
    }
    return doFetch(url, {
      ...requestInit,
      headers: { ...requestInit.headers, Authorization: `Bearer ${token}` },
    });
  };

  const first = await send();
  if (first.status !== 401) return first;

  // The stored token was rejected. Refresh through corsair and try once more —
  // exactly once. A third attempt would just be a retry loop against a mailbox
  // that has already told us twice that its credentials do not work.
  await refresh(tenantId, ctx);

  const retried = await send();

  if (retried.status === 401) {
    const body = await retried.clone().text();
    logger.warn("[GMAIL_AUTH] refresh failed", {
      tenantId,
      trigger: ctx.trigger,
      operation: ctx.operation,
      kind: "still-401-after-refresh",
      body: body.slice(0, 200),
    });
    throw new GmailAuthError(
      tenantId,
      `Gmail rejected a freshly refreshed token for tenant ${tenantId}: ${body.slice(0, 200)}`,
      401,
    );
  }

  logger.info("[GMAIL_AUTH] refresh succeeded", {
    tenantId,
    trigger: ctx.trigger,
    operation: ctx.operation,
    retriedStatus: retried.status,
  });

  return retried;
}
