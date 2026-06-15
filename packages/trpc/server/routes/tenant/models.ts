import { z } from "zod";

// Define the output schema for creating a form
export const authorizePluginsOutputModel = z.object({
  url: z.string().describe("The URL to authorize plugins for the tenant"),
});

// Output schema for the Gmail OAuth URL generation
export const getGmailOAuthUrlOutputModel = z.object({
  url: z.string().url().describe("The Gmail OAuth authorization URL"),
  state: z.string().describe("HMAC-signed state parameter for callback verification"),
});
