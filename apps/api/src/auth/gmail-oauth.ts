import { Router } from "express";
import { processGmailOAuthCallback } from "@repo/trpc/services";

const DASHBOARD_URL = "http://localhost:3000/dashboard";

export const gmailOAuthRouter = Router();

/**
 * GET /api/auth/gmail-callback
 *
 * Google redirects here after the user approves OAuth access.
 * Corsair exchanges the authorization code for tokens and stores them
 * encrypted in the local database (same as CLI flow).
 *
 * On success → redirect to /dashboard?connected=gmail
 * On failure → redirect to /dashboard?error=oauth_failed
 */
gmailOAuthRouter.get("/", async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    console.error("OAuth error:", error);
    return res.redirect(`${DASHBOARD_URL}?error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    console.error("Missing code or state in OAuth callback");
    return res.redirect(`${DASHBOARD_URL}?error=missing_code_or_state`);
  }

  try {
    const result = await processGmailOAuthCallback(code, state);

    console.log(
      `OAuth connected: plugin=${result.plugin}, tenantId=${result.tenantId}`,
    );

    return res.redirect(
      `${DASHBOARD_URL}?connected=${encodeURIComponent(result.plugin)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("OAuth callback failed:", message);
    return res.redirect(
      `${DASHBOARD_URL}?error=${encodeURIComponent(message)}`,
    );
  }
});
