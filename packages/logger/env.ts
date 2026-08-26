import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),

  /**
   * Overrides the per-environment default (`debug` in development, `info` in
   * production). Optional, but set it EXPLICITLY in deployed environments — the
   * production default was `error` for a long time while this variable was set
   * nowhere, which silently discarded every `logger.info` in the codebase.
   */
  LOGGER_LEVEL: z.enum(["error", "debug", "info"]).optional(),

  /**
   * Path for the file transport. Absolute is taken as given; relative resolves
   * against the WORKSPACE ROOT, never the CWD — see log-root.ts.
   *
   * Unset in development still gets `<root>/logs/app.log`, because development
   * restarts constantly and loses the most. Unset in production means no file
   * transport at all: stdout is the primary path there and Docker captures it.
   *
   * Declared here rather than read as a bare `process.env` so that it is
   * discoverable — it was previously invisible in both `.env.example` and this
   * schema, which is how a knob nobody knows exists stops being used.
   */
  LOG_FILE: z.string().optional(),
});

function createEnv(env: NodeJS.ProcessEnv) {
  const safeParseResult = envSchema.safeParse(env);
  if (!safeParseResult.success) throw new Error(safeParseResult.error.message);
  return safeParseResult.data;
}

export const env = createEnv(process.env);
