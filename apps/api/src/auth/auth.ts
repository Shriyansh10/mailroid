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
});

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
export type User = (typeof auth.$Infer.Session)["user"];