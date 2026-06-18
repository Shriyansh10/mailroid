import { Router } from "express";
import { processOAuthCallbackForPlugin, storeCalendarConnectedEmail } from "@repo/trpc/services";
import { startCalendarWatch } from "@repo/services/calendar/watch.ts";

import { env } from "../env.js";

const CALENDAR_CALLBACK_URL =
  process.env.CALENDAR_OAUTH_CALLBACK_URL ??
  `${env.BASE_URL}/api/auth/calendar-callback`;

const DASHBOARD_URL = `${env.FRONTEND_URL}/onboarding`;

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

    // Fetch and persist the connected Calendar account email and trigger automatic watch setup
    const email = await storeCalendarConnectedEmail(result.tenantId);
    if (email) {
      await startCalendarWatch(result.tenantId);
    }

    return res.redirect(`${DASHBOARD_URL}?connected=${encodeURIComponent(result.plugin)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.redirect(`${DASHBOARD_URL}?error=${encodeURIComponent(message)}`);
  }
});
