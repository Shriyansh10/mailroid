import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { Router } from "express";

/**
 * Gmail / Google Calendar OAuth callbacks, and the ownership check that gates
 * them.
 *
 * THE BUG THIS EXISTS FOR. Corsair's `state` is an HMAC-signed
 * {plugin, tenantId, iat} ticket. It proves *Mailroid issued* the ticket — it
 * does not prove *who is holding the browser* when Google redirects back. The
 * callbacks used to trust it alone, so an attacker could mint a ticket for
 * their own account, send the Google consent link to a victim, and the
 * victim's mailbox would be stored under the attacker's tenant (and, for an
 * existing Mailroid user, have its gmail_tenant_mappings row re-pointed away
 * from them).
 *
 * THE FIX. Before anything is written, the callback requires:
 *   1. a ticket whose signature, shape, plugin and age all check out, AND
 *   2. a signed-in Better Auth session, AND
 *   3. that session's user id === the ticket's tenantId.
 * Only then is the code exchanged (which is where corsair stores tokens and
 * creates the account row), and only then do mapping writes, watches and syncs
 * run. A refusal touches nothing.
 *
 * This module deliberately imports nothing that touches the database, corsair
 * or env validation, so the tests can drive the real routing and ordering with
 * spies standing in for those effects. The wiring lives in gmail-oauth.ts and
 * calendar-oauth.ts.
 */

export type OAuthPlugin = "gmail" | "googlecalendar";

/**
 * Same lifetime corsair enforces on the ticket (`dn = 600 * 1e3` in
 * corsair@0.1.74). Corsair re-checks on its side; this copy exists so the
 * ownership decision is made on a ticket already known to be live.
 */
export const OAUTH_TICKET_MAX_AGE_MS = 10 * 60 * 1000;

/** Tolerated clock skew for a ticket stamped slightly in the future. */
const FUTURE_SKEW_MS = 60 * 1000;

/**
 * `<base64url payload>.<base64url HMAC-SHA256>`. 43 characters is an unpadded
 * 32-byte digest; the last character can only be one of 16 values because its
 * low two bits are padding, which is also enforced so a single digest has a
 * single accepted spelling. Payload capped well above any real ticket (~120
 * chars) so an oversized state is refused before it is hashed.
 */
const TICKET_FORMAT = /^([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;

export type TicketCheck =
  | { ok: true; plugin: string; tenantId: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verifies a corsair OAuth ticket: `<base64url(JSON)>.<base64url(HMAC-SHA256)>`
 * keyed with CORSAIR_KEK — the exact format corsair's `generateOAuthUrl` signs
 * (corsair does not export its verifier, only an unsigned decoder).
 *
 * Fails CLOSED. If corsair ever changes its format, every callback is refused
 * as `bad_signature`/`malformed` and logged — a loud outage, never a silently
 * unchecked ticket.
 */
export function verifyOAuthTicket(state: string, kek: string, now: number = Date.now()): TicketCheck {
  // EXACT FORMAT FIRST. Buffer.from(x, "base64url") silently skips characters
  // outside the alphabet, so a lenient decode would accept `<sig>!!` or
  // `<sig>==` as the same signature. Corsair's own verifier is that lenient;
  // this one is not. A ticket is one base64url payload, one dot, and a 43-char
  // base64url HMAC-SHA256 — anything else is malformed before any crypto runs.
  const match = TICKET_FORMAT.exec(state);
  if (!match) return { ok: false, reason: "malformed" };
  const payload = match[1]!;
  const signature = match[2]!;

  // The MAC covers the payload string byte for byte, exactly as signed.
  // Both sides are 32 bytes by construction (format check above), so
  // timingSafeEqual never sees a length mismatch and leaks nothing.
  const provided = Buffer.from(signature, "base64url");
  const expected = crypto.createHmac("sha256", kek).update(payload).digest();
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (decoded === null || typeof decoded !== "object") return { ok: false, reason: "malformed" };

  const { plugin, tenantId, iat } = decoded as Record<string, unknown>;
  if (typeof plugin !== "string" || typeof tenantId !== "string" || tenantId.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  // Corsair always stamps iat. A signed ticket without one is not something
  // Mailroid issued in this version, so it is not given an unbounded lifetime.
  if (typeof iat !== "number" || !Number.isFinite(iat)) return { ok: false, reason: "malformed" };
  if (now - iat > OAUTH_TICKET_MAX_AGE_MS || iat - now > FUTURE_SKEW_MS) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, plugin, tenantId };
}

export type CallbackRefusal =
  | "not_configured"
  | "ticket_malformed"
  | "ticket_bad_signature"
  | "ticket_expired"
  | "wrong_plugin"
  | "not_signed_in"
  | "session_mismatch";

export type CallbackDecision = { ok: true; tenantId: string } | { ok: false; reason: CallbackRefusal; ticketTenantId?: string };

/**
 * The whole authorization decision, pure. The session must belong to the very
 * user the ticket names — the ticket alone is never proof of who the browser is.
 */
export function authorizeOAuthCallback(input: {
  state: string;
  expectedPlugin: OAuthPlugin;
  sessionUserId: string | null;
  kek: string | undefined;
  now?: number;
}): CallbackDecision {
  if (!input.kek) return { ok: false, reason: "not_configured" };

  const ticket = verifyOAuthTicket(input.state, input.kek, input.now);
  if (!ticket.ok) {
    const reason = ticket.reason === "expired" ? "ticket_expired" : ticket.reason === "bad_signature" ? "ticket_bad_signature" : "ticket_malformed";
    return { ok: false, reason };
  }
  if (ticket.plugin !== input.expectedPlugin) return { ok: false, reason: "wrong_plugin" };
  if (!input.sessionUserId) return { ok: false, reason: "not_signed_in", ticketTenantId: ticket.tenantId };
  if (input.sessionUserId !== ticket.tenantId) {
    return { ok: false, reason: "session_mismatch", ticketTenantId: ticket.tenantId };
  }
  return { ok: true, tenantId: ticket.tenantId };
}

// ── User-facing wording ────────────────────────────────────────────────
// Shown as plain text by the onboarding page. Ours, never an echo of input.

export const CONNECT_MISMATCH_MESSAGE =
  "This connection link was started from a different Mailroid account, so nothing was connected. " +
  "If you didn't start it yourself, someone may have sent you this link — don't use it. " +
  "To connect your own Google account, start again from this page.";

export const CONNECT_TICKET_MESSAGE =
  "This connection link is invalid or has expired, so nothing was connected. Please start again.";

export const CONNECT_UNAVAILABLE_MESSAGE =
  "Connecting Google accounts is unavailable right now. Nothing was changed — please try again later.";

/** Sign-in page error code; its sentence lives in apps/web/lib/sign-in-errors.ts. */
export const CONNECT_REQUIRES_SIGN_IN_CODE = "connect_requires_sign_in";

// ── Router ──────────────────────────────────────────────────────────────

export interface OAuthCallbackRouterDeps {
  plugin: OAuthPlugin;
  frontendUrl: string;
  /** Read per request so a test (or a rotated env) is never stuck with a stale key. */
  getKek: () => string | undefined;
  /** The Better Auth session's user id for these request headers, or null. */
  getSessionUserId: (headers: IncomingHttpHeaders) => Promise<string | null>;
  /**
   * Runs ONLY after the ownership check has passed: exchanges the code (which
   * stores tokens) and does the plugin's follow-up work. Returns where to send
   * the browser. Owns its own error handling, exactly as the callbacks did.
   */
  complete: (args: { code: string; state: string; tenantId: string }) => Promise<string>;
  now?: () => number;
  warn?: (message: string) => void;
}

export function createOAuthCallbackRouter(deps: OAuthCallbackRouterDeps): Router {
  const router = Router();
  const dashboardUrl = `${deps.frontendUrl}/onboarding`;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const tag = deps.plugin === "gmail" ? "gmail-oauth" : "calendar-oauth";

  router.get("/", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const error = typeof req.query.error === "string" ? req.query.error : undefined;

    if (error) {
      return res.redirect(`${dashboardUrl}?error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) {
      return res.redirect(`${dashboardUrl}?error=missing_code_or_state`);
    }

    let sessionUserId: string | null;
    try {
      sessionUserId = await deps.getSessionUserId(req.headers);
    } catch (err) {
      // A session lookup that cannot complete is not a session. Fail closed.
      warn(`[${tag}] session lookup failed, refusing callback: ${err instanceof Error ? err.message : String(err)}`);
      sessionUserId = null;
    }

    const decision = authorizeOAuthCallback({
      state,
      expectedPlugin: deps.plugin,
      sessionUserId,
      kek: deps.getKek(),
      now: deps.now?.(),
    });

    if (!decision.ok) {
      switch (decision.reason) {
        case "session_mismatch":
          // The signature of the account-linking attack, or a user with two
          // Mailroid accounts in one browser. Either way: nothing is written.
          warn(
            `[${tag}] SECURITY refused: signed-in user ${sessionUserId} tried to complete a ticket issued to ${decision.ticketTenantId}`,
          );
          return res.redirect(`${dashboardUrl}?error=${encodeURIComponent(CONNECT_MISMATCH_MESSAGE)}`);
        case "not_signed_in":
          warn(`[${tag}] refused: no signed-in session for a ticket issued to ${decision.ticketTenantId}`);
          return res.redirect(`${deps.frontendUrl}/sign-in?error=${CONNECT_REQUIRES_SIGN_IN_CODE}`);
        case "not_configured":
          warn(`[${tag}] refused: CORSAIR_KEK is not set, cannot verify the OAuth ticket`);
          return res.redirect(`${dashboardUrl}?error=${encodeURIComponent(CONNECT_UNAVAILABLE_MESSAGE)}`);
        default:
          warn(`[${tag}] refused: ${decision.reason}`);
          return res.redirect(`${dashboardUrl}?error=${encodeURIComponent(CONNECT_TICKET_MESSAGE)}`);
      }
    }

    return res.redirect(await deps.complete({ code, state, tenantId: decision.tenantId }));
  });

  return router;
}

// ── Per-plugin completion (unchanged behaviour, moved behind the check) ──

export interface GmailCompletionDeps {
  frontendUrl: string;
  callbackUrl: string;
  processCallback: (code: string, state: string, callbackUrl: string) => Promise<{ plugin: string; tenantId: string }>;
  storeConnectedEmail: (tenantId: string) => Promise<unknown>;
  startWatch: (tenantId: string) => Promise<unknown>;
  triggerSync: (tenantId: string) => Promise<unknown>;
  rollback: (tenantId: string) => Promise<void>;
  takeReturnTo: (tenantId: string, fallback: string) => string;
}

export function createGmailCompletion(deps: GmailCompletionDeps): OAuthCallbackRouterDeps["complete"] {
  const dashboardUrl = `${deps.frontendUrl}/onboarding`;
  return async ({ code, state }) => {
    // Captured outside the try so the catch can roll back. Everything that can
    // fail below runs AFTER the token has already been persisted, so the
    // rollback needs the tenant id even on the failure path.
    let tenantId: string | undefined;
    try {
      const result = await deps.processCallback(code, state, deps.callbackUrl);
      tenantId = result.tenantId;

      await deps.storeConnectedEmail(result.tenantId);
      await deps.startWatch(result.tenantId);

      // Fire-and-forget so the redirect is instant.
      void deps.triggerSync(result.tenantId).catch((err) =>
        console.error("[gmail-oauth] triggerGmailSync failed:", err),
      );

      const returnUrl = `${deps.frontendUrl}${deps.takeReturnTo(result.tenantId, "/onboarding")}`;
      return `${returnUrl}?connected=${encodeURIComponent(result.plugin)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A connect is all-or-nothing: the token write happens inside
      // processCallback, so a later failure must undo it or the UI shows
      // "Connected ✓" for a mailbox with no mapping and no watch.
      if (tenantId) {
        await deps.rollback(tenantId).catch((rollbackErr) =>
          console.error("[gmail-oauth] rollback failed — tenant may be half-connected:", rollbackErr),
        );
      }
      return `${dashboardUrl}?error=${encodeURIComponent(message)}`;
    }
  };
}

export interface CalendarCompletionDeps {
  frontendUrl: string;
  callbackUrl: string;
  processCallback: (code: string, state: string, callbackUrl: string) => Promise<{ plugin: string; tenantId: string }>;
  storeConnectedEmail: (tenantId: string) => Promise<string | null>;
  startWatch: (tenantId: string) => Promise<unknown>;
  takeReturnTo: (tenantId: string, fallback: string) => string;
}

export function createCalendarCompletion(deps: CalendarCompletionDeps): OAuthCallbackRouterDeps["complete"] {
  const dashboardUrl = `${deps.frontendUrl}/onboarding`;
  return async ({ code, state }) => {
    try {
      const result = await deps.processCallback(code, state, deps.callbackUrl);
      const email = await deps.storeConnectedEmail(result.tenantId);
      if (email) {
        await deps.startWatch(result.tenantId);
      }
      const returnUrl = `${deps.frontendUrl}${deps.takeReturnTo(result.tenantId, "/onboarding")}`;
      return `${returnUrl}?connected=${encodeURIComponent(result.plugin)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `${dashboardUrl}?error=${encodeURIComponent(message)}`;
    }
  };
}
