import { betterAuth } from "better-auth";
import { db } from "@repo/database";
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
      // input: false stops a user setting their own isAdmin via any
      // self-service update-profile call. There is no admin-management UI —
      // the only supported way to create an admin is flipping this column
      // directly via SQL/Drizzle Studio.
      isAdmin: {
        type: "boolean",
        defaultValue: false,
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
});

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
export type User = (typeof auth.$Infer.Session)["user"];