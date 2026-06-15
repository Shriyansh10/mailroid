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