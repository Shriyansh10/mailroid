import { betterAuth } from "better-auth";
import { db } from "@repo/database";
import { isTenantFenced, FENCED_SIGN_IN_MESSAGE } from "@repo/database/tenant-fence";
import { onAccountLinked } from "@repo/database/deletion-suppression";
import { logger } from "@repo/logger";
import { APIError } from "better-auth/api";
// @ts-ignore
import { authModels } from "@repo/database/schema";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authModels,
  }),

  trustedOrigins: [process.env.FRONTEND_URL || "http://localhost:3000"],

  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,

  user: {
    additionalFields: {
      // input: false stops a user granting themselves DEVELOPER via any
      // self-service update-profile call. Promotion is deliberately not a
      // self-service operation — it happens through the developer grant path
      // or directly in the database.
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
    // A Google account that belonged to a deleted account signs up again:
    // registration goes ahead, and a developer is asked to review it. Nothing
    // of the old account is restored, and a failure here never fails sign-up.
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

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
export type User = (typeof auth.$Infer.Session)["user"];