import "dotenv/config";
import { defineConfig } from "drizzle-kit";
// @ts-ignore
import { env } from "./env";

export default defineConfig({
  out: "./drizzle",
  schema: "./schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
