/**
 * Server-side Better Auth instance for apps/web.
 *
 * Purpose:
 *   Read the authenticated session from incoming Next.js route handler requests.
 *   The session cookie (better-auth.session_token) is forwarded automatically
 *   by the browser on every same-origin request.
 *
 * This instance connects to the same Postgres database and uses the same
 * BETTER_AUTH_SECRET as apps/api, so sessions created by the Express API
 * are valid here.
 *
 * Usage (in a route handler):
 *   import { auth } from "@web/lib/auth";
 *   const session = await auth.api.getSession({ headers: request.headers });
 *   const userId = session?.user?.id ?? null;
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@repo/database";
// @ts-ignore – schema re-exports
import { authModels } from "@repo/database/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authModels,
  }),

  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
});
