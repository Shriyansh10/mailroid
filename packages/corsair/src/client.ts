import { createClient } from "@corsair-dev/app";

export const corsairClient = createClient({
  apiKey: process.env.CORSAIR_DEV_KEY!,
});
