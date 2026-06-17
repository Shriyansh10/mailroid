import { Router } from "express";
import { processOAuthCallbackForPlugin, storeGmailConnectedEmail } from "@repo/trpc/services";
import { syncMailbox } from "@repo/services/gmail/sync-metadata";

const GMAIL_CALLBACK_URL =
  process.env.GMAIL_OAUTH_CALLBACK_URL ??
  "http://localhost:8000/api/auth/gmail-callback";

const DASHBOARD_URL = "http://localhost:3000/onboarding";

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
    //await storeGmailConnectedEmail(result.tenantId);

    // Sync mailbox metadata for all categories so the inbox is immediately populated
    void syncMailbox(result.tenantId).catch((err) =>
      console.error("[gmail-oauth] syncMailbox failed:", err),
    );

    return res.redirect(`${DASHBOARD_URL}?connected=${encodeURIComponent(result.plugin)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.redirect(`${DASHBOARD_URL}?error=${encodeURIComponent(message)}`);
  }
});
