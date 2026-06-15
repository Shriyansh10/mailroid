import { createClient } from "@corsair-dev/app";
import 'dotenv/config'

export const corsairClient = createClient({
    apiKey: process.env.CORSAIR_DEV_KEY!,
});

