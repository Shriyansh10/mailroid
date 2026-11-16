import { processOAuthCallbackForPlugin, rollbackGmailConnection, storeGmailConnectedEmail, takeOAuthReturnTo } from "@repo/trpc/services";
import { triggerGmailSync } from "@repo/services/gmail/sync-metadata";
import { startGmailWatch } from "@repo/services/gmail/watch.ts";

import { env } from "../env.js";
import { createGmailCompletion, createOAuthCallbackRouter } from "./oauth-callback.js";
import { sessionUserIdFromHeaders } from "./session-user.js";

const GMAIL_CALLBACK_URL =
  process.env.GMAIL_OAUTH_CALLBACK_URL ??
  `${env.BASE_URL}/api/auth/gmail-callback`;

/**
 * Gmail OAuth callback. The ownership check (signed-in user === the ticket's
 * tenant) runs before any token, mapping, watch or sync — see oauth-callback.ts.
 */
export const gmailOAuthRouter = createOAuthCallbackRouter({
  plugin: "gmail",
  frontendUrl: env.FRONTEND_URL,
  getKek: () => process.env.CORSAIR_KEK,
  getSessionUserId: sessionUserIdFromHeaders,
  complete: createGmailCompletion({
    frontendUrl: env.FRONTEND_URL,
    callbackUrl: GMAIL_CALLBACK_URL,
    processCallback: processOAuthCallbackForPlugin,
    storeConnectedEmail: storeGmailConnectedEmail,
    startWatch: startGmailWatch,
    // Durable Inngest job when configured, in-process fallback otherwise.
    triggerSync: triggerGmailSync,
    rollback: rollbackGmailConnection,
    takeReturnTo: takeOAuthReturnTo,
  }),
});
