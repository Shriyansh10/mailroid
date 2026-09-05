import { Router } from "express";
import { processOAuthCallbackForPlugin, rollbackGmailConnection, storeGmailConnectedEmail } from "@repo/trpc/services";
import { triggerGmailSync } from "@repo/services/gmail/sync-metadata";
import { startGmailWatch } from "@repo/services/gmail/watch.ts";

import { env } from "../env.js";

const GMAIL_CALLBACK_URL =
  process.env.GMAIL_OAUTH_CALLBACK_URL ??
  `${env.BASE_URL}/api/auth/gmail-callback`;

const DASHBOARD_URL = `${env.FRONTEND_URL}/onboarding`;

export const gmailOAuthRouter = Router();

gmailOAuthRouter.get("/", async (req, res) => {
  console.log("[gmail-oauth] callback HIT");
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    return res.redirect(`${DASHBOARD_URL}?error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return res.redirect(`${DASHBOARD_URL}?error=missing_code_or_state`);
  }

  // Captured outside the try so the catch can roll back. Everything that can
  // fail below runs AFTER the token has already been persisted, so the rollback
  // needs the tenant id even on the failure path.
  let tenantId: string | undefined;

  try {
    const result = await processOAuthCallbackForPlugin(code, state, GMAIL_CALLBACK_URL);
    tenantId = result.tenantId;

    // Fetch and persist the connected Gmail email address
    await storeGmailConnectedEmail(result.tenantId);
    await startGmailWatch(result.tenantId);

    // Kick off the full mailbox sync (durable Inngest job when configured,
    // in-process fallback otherwise). Fire-and-forget so the redirect is instant.
    void triggerGmailSync(result.tenantId).catch((err) =>
      console.error("[gmail-oauth] triggerGmailSync failed:", err),
    );

    return res.redirect(`${DASHBOARD_URL}?connected=${encodeURIComponent(result.plugin)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // A connect is all-or-nothing. processOAuthCallbackForPlugin has already
    // persisted the token by the time anything below it can fail, so without
    // this the tenant keeps a corsair_accounts row, getAccountsExist reports
    // gmail: true, and the user is shown "Connected ✓" for a mailbox that has
    // no mapping, no watch, and no path back to working. Roll it back so the
    // UI offers Connect again and a retry is a clean retry.
    //
    // If processOAuthCallbackForPlugin itself threw, tenantId is undefined and
    // there is nothing of ours to undo — the token write is inside that call,
    // so it either completed and gave us an id, or it did not happen.
    if (tenantId) {
      await rollbackGmailConnection(tenantId).catch((rollbackErr) =>
        // Surfaced, never swallowed: a failed rollback leaves exactly the
        // half-connected state this code exists to prevent, and the log line is
        // the only warning anyone will get.
        console.error("[gmail-oauth] rollback failed — tenant may be half-connected:", rollbackErr),
      );
    }

    return res.redirect(`${DASHBOARD_URL}?error=${encodeURIComponent(message)}`);
  }
});
