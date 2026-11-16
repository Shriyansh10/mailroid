import { processOAuthCallbackForPlugin, storeCalendarConnectedEmail, takeOAuthReturnTo } from "@repo/trpc/services";
import { startCalendarWatch } from "@repo/services/calendar/watch.ts";

import { env } from "../env.js";
import { createCalendarCompletion, createOAuthCallbackRouter } from "./oauth-callback.js";
import { sessionUserIdFromHeaders } from "./session-user.js";

const CALENDAR_CALLBACK_URL =
  process.env.CALENDAR_OAUTH_CALLBACK_URL ??
  `${env.BASE_URL}/api/auth/calendar-callback`;

/**
 * Google Calendar OAuth callback. Same ownership check as Gmail, before any
 * token, mapping or watch — see oauth-callback.ts.
 */
export const calendarOAuthRouter = createOAuthCallbackRouter({
  plugin: "googlecalendar",
  frontendUrl: env.FRONTEND_URL,
  getKek: () => process.env.CORSAIR_KEK,
  getSessionUserId: sessionUserIdFromHeaders,
  complete: createCalendarCompletion({
    frontendUrl: env.FRONTEND_URL,
    callbackUrl: CALENDAR_CALLBACK_URL,
    processCallback: processOAuthCallbackForPlugin,
    storeConnectedEmail: storeCalendarConnectedEmail,
    startWatch: startCalendarWatch,
    takeReturnTo: takeOAuthReturnTo,
  }),
});
