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
import { isTenantFenced, FENCED_SIGN_IN_MESSAGE } from "@repo/database/tenant-fence";
import { onAccountLinked } from "@repo/database/deletion-suppression";
import { logger } from "@repo/logger";
import { APIError } from "better-auth/api";
// @ts-ignore – schema re-exports
import { authModels } from "@repo/database/schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authModels,
  }),

  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,

  // Must mirror apps/api/src/auth/auth.ts's additionalFields exactly — both
  // instances point at the same `user` table, and Better Auth only includes
  // declared fields in the returned session/user object, not a raw SELECT *.
  user: {
    additionalFields: {
      platformRole: {
        type: "string",
        defaultValue: "USER",
        input: false,
      },
    },
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },

  // Account deletion: a fenced user gets no new session. The tenant fence
  // trigger would reject the INSERT anyway; this turns that into a readable
  // refusal instead of a failed sign-in with a database error.
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          if (await isTenantFenced(session.userId)) {
            throw new APIError("FORBIDDEN", { message: FENCED_SIGN_IN_MESSAGE });
          }
        },
      },
    },
    // Mirrors apps/api: a returning deleted Google account is flagged for
    // developer review, never blocked and never restored.
    account: {
      create: {
        after: async (account) => {
          try {
            const opened = await onAccountLinked(account);
            if (opened) logger.info("[account-deletion] re-registration flagged for review", { userId: account.userId, reviews: opened });
          } catch (err) {
            logger.error("[account-deletion] re-registration check failed", { userId: account.userId, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
          }
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
