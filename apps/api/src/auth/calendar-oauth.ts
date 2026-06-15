import { Router } from "express";
import { processOAuthCallbackForPlugin, storeCalendarConnectedEmail } from "@repo/trpc/services";

const CALENDAR_CALLBACK_URL =
  process.env.CALENDAR_OAUTH_CALLBACK_URL ??
  "http://localhost:8000/api/auth/calendar-callback";

const DASHBOARD_URL = "http://localhost:3000/onboarding";

export const calendarOAuthRouter = Router();

calendarOAuthRouter.get("/", async (req, res) => {
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
    const result = await processOAuthCallbackForPlugin(code, state, CALENDAR_CALLBACK_URL);

    // Fetch and persist the connected Calendar account email
    await storeCalendarConnectedEmail(result.tenantId);

    return res.redirect(`${DASHBOARD_URL}?connected=${encodeURIComponent(result.plugin)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.redirect(`${DASHBOARD_URL}?error=${encodeURIComponent(message)}`);
  }
});
