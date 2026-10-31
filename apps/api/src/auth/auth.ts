import { betterAuth } from "better-auth";
import { db } from "@repo/database";
import { isTenantFenced, isDeletionUnsealed, isFencedGoogleSignIn, FENCED_SIGN_IN_CODE, FENCED_SIGN_IN_MESSAGE } from "@repo/database/tenant-fence";
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

  // OAuth failures land on the sign-in page, which says what happened (an
  // account being deleted gets the full sentence) instead of Better Auth's
  // generic error page.
  onAPIError: { errorURL: `${process.env.FRONTEND_URL || "http://localhost:3000"}/sign-in` },
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
    // Once the purge has removed the user row, the session check below has
    // nothing to match: the OAuth callback would create a brand-new user,
    // unflagged, because the suppression marker is only written at COMPLETED.
    // Refused here, before the user, account or session row exists.
    user: {
      create: {
        before: async (user) => {
          if (await isDeletionUnsealed(user.email)) {
            logger.info("[account-deletion] sign-up refused: deletion not yet sealed");
            // Here Better Auth turns the message itself into ?error=, so it must be the code.
            throw new APIError("FORBIDDEN", { message: FENCED_SIGN_IN_CODE, code: FENCED_SIGN_IN_CODE });
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          if (await isTenantFenced(session.userId)) {
            throw new APIError("FORBIDDEN", { message: FENCED_SIGN_IN_MESSAGE, code: FENCED_SIGN_IN_CODE });
          }
        },
      },
    },
    account: {
      // A returning fenced user: Better Auth writes Google's fresh tokens
      // before the session, and the fence trigger rejects that write as a raw
      // database error. Refuse it here, with the message, first.
      update: {
        before: async (data) => {
          if (await isFencedGoogleSignIn(data)) {
            throw new APIError("FORBIDDEN", { message: FENCED_SIGN_IN_MESSAGE, code: FENCED_SIGN_IN_CODE });
          }
        },
      },
      // A Google account that belonged to a deleted account signs up again:
      // registration goes ahead, and a developer is asked to review it. Nothing
      // of the old account is restored, and a failure here never fails sign-up.
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