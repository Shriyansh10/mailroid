import { z } from "zod";

const googleClientKeysEnvSchema = z.object({
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
});

function createEnv(env: NodeJS.ProcessEnv, schema: z.ZodObject) {
  const safeParseResult = schema.safeParse(env);
  if (!safeParseResult.success) throw new Error(safeParseResult.error.message);
  return safeParseResult.data;
}

export const googleClientKeysEnv = createEnv(process.env, googleClientKeysEnvSchema);

const corsairInstanceIdEnvSchema = z.object({
  CORSAIR_INSTANCE_ID: z.string(),
});

export const corsairInstanceIdEnv = createEnv(process.env, corsairInstanceIdEnvSchema);