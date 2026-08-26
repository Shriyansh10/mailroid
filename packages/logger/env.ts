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

  /**
   * Key for the mailbox digests in pii.ts. Declared here for the same reason
   * LOG_FILE is: a knob nobody can find is a knob nobody uses, and this one
   * fails silently — with it unset, every digest reads `<no-hash-secret>` and
   * the logs simply stop correlating by mailbox. Nothing leaks, nothing errors,
   * and nothing tells you until you go looking for a mailbox and find 106
   * identical markers.
   *
   * OPTIONAL ON PURPOSE, and it must stay optional: pii.ts already degrades
   * safely without it, and a logger that refuses to import is a worse failure
   * than one that correlates poorly.
   *
   * NOT READ FROM HERE. pii.ts reads `process.env.LOG_HASH_SECRET` at call
   * time, deliberately — this module parses once at import, and a value that
   * arrives later (a dotenv wrapper, a test setting it up) would be frozen out.
   * The declaration is documentation and discoverability, not the read path.
   *
   * MUST BE STABLE FOR THE LIFETIME OF AN ENVIRONMENT. A value that changes
   * across restarts produces a different digest for the same mailbox each time,
   * which destroys exactly the correlation the digest exists to provide. Give
   * production its own value, different from development's.
   */
  LOG_HASH_SECRET: z.string().optional(),
});

function createEnv(env: NodeJS.ProcessEnv) {
  const safeParseResult = envSchema.safeParse(env);
  if (!safeParseResult.success) throw new Error(safeParseResult.error.message);
  return safeParseResult.data;
}

export const env = createEnv(process.env);
