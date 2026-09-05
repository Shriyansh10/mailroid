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
// Safe against the invariant above: call-ledger imports @repo/logger and
// nothing else from this package, so no gate can arrive through it.
import {
  gmailOperationFromUrl,
  quotaUnitsFor,
  quotaUnitsForPacing,
  recordGmailCall,
} from "./call-ledger.ts";
// Safe against the invariant above for the same reason call-ledger is: this
// module imports only @repo/logger and the pure ./gmail-errors, so no gate can
// arrive through it. There is a test asserting that import list.
import { acquireQuota, chargeQuota } from "./quota-limiter.ts";
// P-5a (docs/gmail-rate-limit-boundary.md §13). Safe against the "no gate
// through quota-limiter.ts" invariant above: this resolves a mailbox address
// via a cached DB read, never a cooldown/pause check, and never throws — see
// mailbox-resolver.ts's own header for why the DB read belongs here and not
// inside quota-limiter.ts itself.
import { resolveMailboxForTenant } from "./mailbox-resolver.ts";
// P-5b + P-12. Structurally safe against the same deadlock this module's
// header forbids gating against: the semaphore can make a caller WAIT, but
// only for OTHER IN-FLIGHT REQUESTS TO FINISH, which happens on wall-clock
// time and does not depend on any Gmail call succeeding — unlike a quota
// cooldown, nothing here can be stuck open by a chain of failures. It never
// throws and never consults cooldown/pause state, so it cannot become a gate.
import { acquireMailboxSlot } from "./mailbox-semaphore.ts";

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
  /** Quota pacing. `acquire` may wait or refuse; `charge` never does — the
   *  asymmetry is what keeps the auth-recovery path unblockable. */
  quota?: {
    acquire?: typeof acquireQuota;
    charge?: typeof chargeQuota;
  };
  /** P-5a test seam — real tests use this to avoid touching the database. */
  resolveMailbox?: typeof resolveMailboxForTenant;
  /** P-5b + P-12 test seam. */
  acquireMailboxSlot?: typeof acquireMailboxSlot;
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
  chargeFn: typeof chargeQuota = chargeQuota,
  mailbox?: string,
): Promise<void> {
  logger.info("[GMAIL_AUTH] refresh attempted", {
    tenantId,
    trigger: ctx.trigger,
    operation: ctx.operation,
    cause: "401-on-raw-fetch",
  });

  // The warm-up is a real Gmail request and is counted as one. It is cheap
  // (1 unit) but it is not free, and an auth storm that fires it on every call
  // should be visible as itself rather than as an unexplained gap between the
  // ledger's totals and what the Cloud Console reports.
  const warmUpStartedAt = Date.now();

  // CHARGED, NEVER ADMITTED. This call spends a real quota unit, so the budget
  // has to know about it — but it must never wait for permission. Queueing the
  // authentication warm-up behind a background sync would rebuild the deadlock
  // this module exists to remove, just in slower motion: the refresh cannot be
  // made to depend on the traffic the refresh is meant to unblock.
  //
  // `chargeQuota` is the whole reason the limiter has two verbs. There is a test
  // asserting this function's source contains `chargeQuota` and NOT
  // `acquireQuota`, because the tempting "consistency" edit here is a real bug.
  chargeFn({ tenantId, mailbox, operation: "labels.list", trigger: ctx.trigger, units: 1 });

  try {
    // `{}` is required, not decorative: labelsList's input schema is
    // z.ZodObject<{ userId?: string }> — every field is optional but the
    // argument itself is not, so `list()` is a type error.
    await corsair.withTenant(tenantId).gmail.api.labels.list({});

    recordGmailCall({
      tenantId,
      operation: "labels.list",
      trigger: ctx.trigger,
      ok: true,
      durationMs: Date.now() - warmUpStartedAt,
    });
  } catch (err) {
    recordGmailCall({
      tenantId,
      operation: "labels.list",
      trigger: ctx.trigger,
      ok: false,
      durationMs: Date.now() - warmUpStartedAt,
    });

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
  const acquireFn = hooks?.quota?.acquire ?? acquireQuota;
  const chargeFn = hooks?.quota?.charge ?? chargeQuota;
  const resolveMailboxFn = hooks?.resolveMailbox ?? resolveMailboxForTenant;
  const acquireSlotFn = hooks?.acquireMailboxSlot ?? acquireMailboxSlot;
  const doFetch = hooks?.fetchImpl ?? fetch;

  // P-5a. Resolved once, up front, and reused for every quota call this
  // invocation makes (admission, the auth-recovery warm-up, the post-refresh
  // charge) — one lookup per call, not three. Cached inside the resolver
  // itself, so this is a Map hit on every call but the first per tenant per
  // TTL window; see mailbox-resolver.ts for why it can never throw or block.
  const mailbox = await resolveMailboxFn(tenantId);

  const refresh =
    hooks?.refreshToken ??
    ((id: string, c: GmailCallContext) => refreshTenantToken(id, c, chargeFn, mailbox));

  // What went to Google, derived from the URL rather than from ctx.operation:
  // the raw-fetch sites label themselves by the work they are doing, not by the
  // method they are calling. See gmailOperationFromUrl.
  const operation = gmailOperationFromUrl(url) ?? ctx.operation ?? "unknown";
  const units = quotaUnitsForPacing(operation);
  const fallbackPriced = quotaUnitsFor(operation) === undefined;
  let pacedWaitMs = 0;
  let nonNetworkMs = 0;

  // PACING, NOT A GATE — and the difference is the whole reason this is allowed
  // in a module whose header forbids gates.
  //
  // The 2026-08-25 deadlock existed because the state blocking the refresh could
  // only be cleared BY A SUCCESSFUL GMAIL CALL: cooldown -> blocks refresh ->
  // token stays stale -> 401 -> cooldown. That is a cycle. The limiter's state
  // advances with wall-clock time alone and depends on nothing succeeding, so it
  // cannot close that loop. Background triggers can still be refused when the
  // wait exceeds their 15-minute cap, but that is a bounded refusal which clears
  // itself with time — not a state needing a successful call to escape.
  //
  // And the recovery path skips admission entirely anyway (see
  // refreshTenantToken), so no cap can ever apply to it.
  const { waitedMs } = await acquireFn({
    tenantId,
    mailbox,
    operation,
    trigger: ctx.trigger,
    correlationId: ctx.correlationId,
    units,
    fallbackPriced,
  });
  pacedWaitMs += waitedMs;

  const startedAt = Date.now();
  let networkAttempts = 0;

  const send = async (): Promise<Response> => {
    const token = await getToken(tenantId);
    if (!token) {
      throw new GmailAuthError(
        tenantId,
        `No Gmail access token stored for tenant ${tenantId}`,
      );
    }
    networkAttempts++;

    // P-5b + P-12. Held only around the network call itself, not the token
    // read above — getAccessToken is a local decrypt, never a Gmail request,
    // and holding a concurrency slot for it would count something that never
    // touches Gmail's own per-user concurrent-request limit.
    const release = await acquireSlotFn({ tenantId, mailbox });
    try {
      return await doFetch(url, {
        ...requestInit,
        headers: { ...requestInit.headers, Authorization: `Bearer ${token}` },
      });
    } finally {
      release();
    }
  };

  /**
   * P-5c byte meter (docs/gmail-rate-limit-boundary.md §13). `Content-Length`
   * only — never a body read. Cloning the response to measure an actual byte
   * count would be exact, but every caller of this function still has to
   * consume the ORIGINAL response (`.json()`/`.text()`), and a meter has no
   * business adding a clone + buffer read to every Gmail response just to
   * count it. Gmail sets this header on every response observed in practice;
   * a response without it is simply not counted (`undefined`, not `0` — an
   * absent header is "not measured," not "measured as zero"), consistent
   * with this being a meter, not an enforced budget.
   */
  const responseBytes = (response: Response): number | undefined => {
    const header = response.headers.get("content-length");
    if (!header) return undefined;
    const parsed = Number(header);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  /**
   * `ok` is HTTP success, not "the caller was happy".
   *
   * A 404 from users.history.list is returned to the caller as a normal
   * outcome with a real handler, but it is still a refused request as far as
   * Gmail is concerned, and the rollup's escalation should treat it as one.
   */
  const record = (ok: boolean, response: Response) => {
    recordGmailCall({
      tenantId,
      operation,
      trigger: ctx.trigger,
      correlationId: ctx.correlationId,
      ok,
      attempts: networkAttempts,
      durationMs: Date.now() - startedAt - nonNetworkMs,
      waitedMs: pacedWaitMs || undefined,
      bytes: responseBytes(response),
    });
  };

  const first = await send();
  if (first.status !== 401) {
    record(first.ok, first);
    return first;
  }

  // The stored token was rejected. Refresh through corsair and try once more —
  // exactly once. A third attempt would just be a retry loop against a mailbox
  // that has already told us twice that its credentials do not work.
  await refresh(tenantId, ctx);

  // CHARGED, NOT ACQUIRED — same rule as the warm-up inside refreshTenantToken.
  // This is one bounded extra attempt inside a single authentication-recovery
  // sequence, not ordinary traffic. Making it queue behind a background sync
  // would reintroduce a milder version of the deadlock above; skipping the
  // charge would understate what recovery actually costs.
  chargeFn({
    tenantId,
    mailbox,
    operation,
    trigger: ctx.trigger,
    correlationId: ctx.correlationId,
    units,
  });

  const retried = await send();

  if (retried.status === 401) {
    record(false, retried);
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

  record(retried.ok, retried);

  logger.info("[GMAIL_AUTH] refresh succeeded", {
    tenantId,
    trigger: ctx.trigger,
    operation: ctx.operation,
    retriedStatus: retried.status,
  });

  return retried;
}
