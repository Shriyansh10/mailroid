import { z } from "zod";

// Define the output schema for creating a form
export const authorizePluginsOutputModel = z.object({
  url: z.string().describe("The URL to authorize plugins for the tenant"),
});
