import { z } from "zod";

// Define the output schema for creating a form
export const authorizePluginsOutputModel = z.object({
  url: z.string().describe("The URL to authorize plugins for the tenant"),
});

// Input schema shared by both OAuth URL generators — where to send the user
// back to once the callback completes. Defaults to onboarding when omitted.
export const getOAuthUrlInputModel = z.object({
  returnTo: z.string().startsWith("/").optional()
    .describe("Path to redirect back to after the OAuth callback completes"),
}).optional();

// Output schema for the Gmail OAuth URL generation
export const getGmailOAuthUrlOutputModel = z.object({
  url: z.string().url().describe("The Gmail OAuth authorization URL"),
  state: z.string().describe("HMAC-signed state parameter for callback verification"),
});

// Output schema for the Calendar OAuth URL generation
export const getCalendarOAuthUrlOutputModel = z.object({
  url: z.string().url().describe("The Calendar OAuth authorization URL"),
  state: z.string().describe("HMAC-signed state parameter for callback verification"),
});

// Output schema for checking which plugins are connected
export const connectedPluginsOutputModel = z.object({
  gmail: z.boolean().describe("Whether Gmail is connected"),
  googlecalendar: z.boolean().describe("Whether Calendar is connected"),
});

// Direct DB check — accounts exist in corsair_accounts
export const getAccountsExistOutputModel = z.object({
  gmail: z.boolean().describe("Whether a Gmail account row exists in corsair_accounts"),
  calendar: z.boolean().describe("Whether a Calendar account row exists in corsair_accounts"),
});

// Full connected-account snapshot for onboarding
export const connectedAccountsOutputModel = z.object({
  betterAuthEmail: z.string().describe("The email the user signed in with"),
  gmailEmail: z.string().nullable().describe("Email of the connected Gmail account"),
  calendarEmail: z.string().nullable().describe("Email of the connected Calendar account"),
  gmailConnected: z.boolean().describe("Whether Gmail has valid tokens"),
  calendarConnected: z.boolean().describe("Whether Calendar has valid tokens"),
});
