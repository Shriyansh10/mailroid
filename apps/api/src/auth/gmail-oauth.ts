import { Router } from "express";
import { processOAuthCallbackForPlugin, storeGmailConnectedEmail } from "@repo/trpc/services";
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

  try {
    const result = await processOAuthCallbackForPlugin(code, state, GMAIL_CALLBACK_URL);

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
    return res.redirect(`${DASHBOARD_URL}?error=${encodeURIComponent(message)}`);
  }
});
