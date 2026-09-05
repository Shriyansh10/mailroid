import { z } from "zod";

import {
  isMailboxAllowedUnderPolicy,
  resolveMailboxPolicy,
} from "./mailbox-policy.ts";

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

/**
 * The environment boundary — P-1 + P-11
 * (docs/gmail-rate-limit-boundary.md §13, P-1).
 *
 * Lives here, not in apps/api/src/env.ts: both consumers —
 * tenant/index.ts's allowlist check and gmail/watch.ts's bootstrap gate — are
 * inside @repo/services, which cannot import an apps/api module. This is the
 * lowest shared package both can reach.
 *
 * MAILROID_ENV has no default and no dev fallback. Guessing wrong here is
 * exactly the failure this whole document is about — a local process that
 * silently believes it is production would defeat the allowlist check
 * instead of enforcing it.
 */
const mailroidEnvSchema = z.object({
  MAILROID_ENV: z.enum(["local", "production"]),
  // OPTIONAL IN THE SCHEMA, MANDATORY IN PRACTICE — exactly one of these must
  // be PRESENT, which resolveMailboxPolicy enforces below. They are optional
  // here only so that "absent" and "present but empty" stay distinguishable:
  // zod's .default("") would collapse the two, and that distinction is the
  // whole mechanism (see resolveMailboxPolicy).
  MAILROID_MAILBOX_ALLOWLIST: z.string().optional(),
  MAILROID_MAILBOX_DENYLIST: z.string().optional(),
});

// createEnv's `schema: z.ZodObject` parameter (above) is untyped by design —
// it is shared across schemas with unrelated shapes — so its return loses
// field-level inference. Re-asserted to the schema's own type here rather
// than widening createEnv itself, which every other caller in this file
// relies on staying loose.
const parsedMailroidEnv = createEnv(process.env, mailroidEnvSchema) as z.infer<
  typeof mailroidEnvSchema
>;

const mailboxPolicy = resolveMailboxPolicy(parsedMailroidEnv);

export const mailroidEnv = {
  env: parsedMailroidEnv.MAILROID_ENV,
  mailboxPolicy,
} as const;

/**
 * Logged at import time (once per process) so a misconfigured policy is
 * visible at boot rather than inferred from a refusal three steps later.
 */
console.log(
  `[MAILROID_ENV] running as "${mailroidEnv.env}", ` +
    `policy=${mailboxPolicy.mode}, ${mailboxPolicy.list.size} mailbox(es) listed` +
    (mailboxPolicy.mode === "denylist" && mailboxPolicy.list.size === 0
      ? " — OWNS EVERY MAILBOX (empty denylist)"
      : ""),
);

/** True iff `email` belongs to THIS environment, under its configured policy. */
export function isMailboxAllowedInThisEnvironment(email: string): boolean {
  return isMailboxAllowedUnderPolicy(email, mailboxPolicy);
}