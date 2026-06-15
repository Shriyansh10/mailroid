import {z} from "zod";

// Define the input schema for creating a user with email and password
export const ensureTenantInput = z.object({
    userId: z.string().describe("The user's ID")
});

export type EnsureTenantInputType = z.infer<typeof ensureTenantInput>;

/**
 * Input schema for authorizing Corsair plugins (Gmail + Google Calendar).
 * Requires the user ID to identify the tenant.
 */
export const authorizePluginsInput = z.object({
  userId: z.string().describe("The user's ID (used as the Corsair tenant ID)"),
});

export type AuthorizePluginsInputType = z.infer<typeof authorizePluginsInput>;

/**
 * Output schema — the Connect Link URL that the user visits
 * to grant OAuth consent for Gmail and Google Calendar.
 */
export const authorizePluginsOutput = z.object({
  url: z.string().describe("The Corsair Connect Link URL"),
});

export type AuthorizePluginsOutputType = z.infer<typeof authorizePluginsOutput>;

/**
 * Output schema for generating a Gmail OAuth authorization URL.
 * Uses the Corsair SDK (not Corsair App) — tokens land directly in local DB.
 */
export const getGmailOAuthUrlOutput = z.object({
  url: z.string().describe("The Gmail OAuth authorization URL"),
  state: z.string().describe("HMAC-signed state parameter (verify in callback)"),
});

export type GetGmailOAuthUrlOutput = z.infer<typeof getGmailOAuthUrlOutput>;

/**
 * Output schema for generating a Calendar OAuth authorization URL.
 * Same shape as Gmail — url + HMAC-signed state.
 */
export const getCalendarOAuthUrlOutput = z.object({
  url: z.string().url().describe("The Calendar OAuth authorization URL"),
  state: z.string().describe("HMAC-signed state parameter (verify in callback)"),
});

export type GetCalendarOAuthUrlOutput = z.infer<typeof getCalendarOAuthUrlOutput>;

/**
 * Output schema — which plugins are connected (have valid tokens).
 */


/**
 * Full connected-account snapshot for the onboarding page.
 */
export const connectedAccountsOutput = z.object({
  betterAuthEmail: z.string().describe("The email the user signed in with"),
  gmailEmail: z.string().nullable().describe("Email of the connected Gmail account"),
  calendarEmail: z.string().nullable().describe("Email of the connected Calendar account"),
  gmailConnected: z.boolean().describe("Whether Gmail has valid tokens"),
  calendarConnected: z.boolean().describe("Whether Calendar has valid tokens"),
});

export type ConnectedAccountsOutput = z.infer<typeof connectedAccountsOutput>;

/**
 * Output schema — which plugins are connected (have valid tokens).
 */
export const connectedPluginsOutput = z.object({
  gmail: z.boolean().describe("Whether Gmail is connected"),
  googlecalendar: z.boolean().describe("Whether Calendar is connected"),
});

export type ConnectedPluginsOutput = z.infer<typeof connectedPluginsOutput>;

/**
 * Output schema — checks corsair_accounts table directly for connected integrations.
 * Does NOT use the Corsair SDK or token checks. Pure DB query.
 */
export const getAccountsExistOutput = z.object({
  gmail: z.boolean().describe("Whether a Gmail account row exists in corsair_accounts"),
  calendar: z.boolean().describe("Whether a Calendar account row exists in corsair_accounts"),
});

export type GetAccountsExistOutput = z.infer<typeof getAccountsExistOutput>;