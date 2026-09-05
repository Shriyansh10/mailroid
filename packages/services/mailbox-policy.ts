/**
 * Which mailboxes does this environment own? Pure, dependency-free, and
 * deliberately SIDE-EFFECT-FREE.
 *
 * WHY THIS IS ITS OWN MODULE — the same reason gmail-errors.ts is. env.ts
 * parses GOOGLE_CLIENT_ID, CORSAIR_INSTANCE_ID and MAILROID_ENV at module
 * scope and throws when any is missing, so importing it from a test means
 * inventing five credentials that have nothing to do with the thing under
 * test. Nothing in this file reads process.env, touches the database or logs,
 * so the boundary logic can be asserted directly.
 *
 * env.ts owns the wiring: it reads the variables once and calls
 * resolveMailboxPolicy with them.
 */

/**
 * Normalised the same way `hashMailbox` normalises before hashing (trim +
 * lowercase), so `Foo@Gmail.com` and `foo@gmail.com` cannot land on opposite
 * sides of the boundary. The policy list is the source of truth for mailbox
 * ownership, so it is held to the same normalisation discipline as the thing
 * it is meant to protect.
 */
function parseMailboxList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((addr) => addr.trim().toLowerCase())
      .filter((addr) => addr.length > 0),
  );
}

export type MailboxPolicyMode = "allowlist" | "denylist";

export interface MailboxPolicy {
  mode: MailboxPolicyMode;
  list: Set<string>;
}

/**
 * Decide which ownership model this environment runs, and with what list.
 *
 * TWO MODELS, BECAUSE THE TWO ENVIRONMENTS ARE NOT SYMMETRIC.
 *
 *   allowlist — "I own ONLY these." Right for local: a developer box owns a
 *               handful of named test mailboxes and must never touch anything
 *               else, however it got connected.
 *
 *   denylist  — "I own everything EXCEPT these." Right for production: real
 *               users sign up with addresses nobody can enumerate in advance,
 *               so an allowlist there would refuse every new customer. The
 *               exclusions are the mailboxes another environment has claimed.
 *
 * FAIL-CLOSED BY CONSTRUCTION. Exactly one of the two variables must be
 * PRESENT — absent-vs-empty is the signal, which is why env.ts keeps them
 * `.optional()` rather than defaulting to `""`:
 *
 *   ALLOWLIST=a@b.com    → owns exactly a@b.com
 *   ALLOWLIST=           → owns NOTHING. Fail-closed, and deliberately
 *                          reachable: it is how you park an environment.
 *   DENYLIST=a@b.com     → owns everything except a@b.com
 *   DENYLIST=            → owns EVERYTHING. Legal, but it has to be typed out
 *                          on purpose; it can never be arrived at by omission.
 *   neither              → throws. There is no default ownership model, for
 *                          the same reason MAILROID_ENV has no default: a
 *                          process that guesses this wrong processes another
 *                          environment's mail.
 *   both                 → throws. Ambiguous, and silently resolving the
 *                          ambiguity is how the wrong one wins in production.
 */
export function resolveMailboxPolicy(env: {
  MAILROID_MAILBOX_ALLOWLIST?: string;
  MAILROID_MAILBOX_DENYLIST?: string;
}): MailboxPolicy {
  const allow = env.MAILROID_MAILBOX_ALLOWLIST;
  const deny = env.MAILROID_MAILBOX_DENYLIST;

  if (allow !== undefined && deny !== undefined) {
    throw new Error(
      "Both MAILROID_MAILBOX_ALLOWLIST and MAILROID_MAILBOX_DENYLIST are set. " +
        "Exactly one must be: they are opposite ownership models, and applying " +
        "both would leave which mailboxes this environment owns undefined.",
    );
  }

  if (allow === undefined && deny === undefined) {
    throw new Error(
      "Neither MAILROID_MAILBOX_ALLOWLIST nor MAILROID_MAILBOX_DENYLIST is set. " +
        "One is required, with no default — an environment that has not stated " +
        "which mailboxes it owns must not process mail for any of them. Local " +
        "environments normally set ALLOWLIST (own only these); production " +
        "normally sets DENYLIST (own everything except the ones local claims).",
    );
  }

  return allow !== undefined
    ? { mode: "allowlist", list: parseMailboxList(allow) }
    : { mode: "denylist", list: parseMailboxList(deny!) };
}

/**
 * True iff `email` belongs to an environment running `policy`.
 * Case/whitespace-insensitive, matching the list's own normalisation.
 */
export function isMailboxAllowedUnderPolicy(
  email: string,
  policy: MailboxPolicy,
): boolean {
  const normalised = email.trim().toLowerCase();
  return policy.mode === "allowlist"
    ? policy.list.has(normalised)
    : !policy.list.has(normalised);
}
