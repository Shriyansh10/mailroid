/**
 * What `pnpm admin:prod` may run, and whether `.env.production` is safe to run
 * it with. Pure — no I/O — so every refusal is testable; prod.ts does the I/O.
 *
 * The production path for the deletion lifecycle is the developer panel
 * (/settings/developer): request review, fence, cancel, delete, retry all run
 * inside the production API. This wrapper is the administrative and recovery
 * interface for the few commands the panel doesn't cover. It reaches the
 * production database the same way `db:studio:prod` does: an SSH tunnel to
 * the VPS's loopback-only Postgres, on local port 5433.
 */

/** The local end of the SSH tunnel (ssh -N -L 5433:127.0.0.1:5432 ubuntu@<VPS>). */
export const PROD_TUNNEL_PORT = "5433";

const STORAGE = [
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "OBJECT_STORAGE_PREFIX",
] as const;

/**
 * Checked when the CLI's modules load (services/env.ts, gmail/watch.ts, the AI
 * clients), so every command needs them although none of these commands calls
 * Google, Gmail, Corsair or the AI provider. The intended `.env.production` is
 * the server's ~/mailroid/.env with DATABASE_URL rewritten to the tunnel, which
 * has all of them; listing them here turns a stack trace into a named refusal.
 */
export const BASE_KEYS = [
  "MAILROID_ENV",
  "CORSAIR_INSTANCE_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GMAIL_PUBSUB_TOPIC",
  "AI_API_KEY",
  "EMBEDDINGS_API_KEY",
] as const;

export interface ProdCommand {
  /** Changes production state: needs the typed confirmation. */
  mutates: (args: string[]) => boolean;
  /** Variables the command needs beyond DATABASE_URL. */
  needs: readonly string[];
}

const readOnly: ProdCommand = { mutates: () => false, needs: [] };
const mutating = (needs: readonly string[] = []): ProdCommand => ({ mutates: () => true, needs });

export const PROD_COMMANDS: Record<string, ProdCommand> = {
  // Read-only lookups, for finding the request a recovery command acts on.
  "account:requests": readOnly,
  "account:show": readOnly,
  "account:reregistrations": readOnly,
  // Records the scan; can finish AWAITING_SEAL or open an INTEGRITY_INCIDENT.
  "account:verify-storage": mutating(STORAGE),
  // Deletes objects under a deleted user's prefix.
  "account:remediate": mutating(STORAGE),
  "account:hold": mutating(),
  "account:review-resolve": mutating(),
  // Preview by default; only --execute expires anything.
  "account:retention": { mutates: (args) => args.includes("--execute"), needs: [] },
};

const PANEL = "Run it from the developer panel (/settings/developer), which runs it inside the production API.";

/** Commands that exist but are refused here, and why. */
export const NOT_HERE: Record<string, string> = {
  "account:fence": PANEL,
  "account:fence-retry": PANEL,
  "account:cancel": PANEL,
  "account:reject": PANEL,
  "account:delete": PANEL,
  "account:retry": PANEL,
  "account:ledger-reconcile":
    "Unavailable: the deletion ledger is deferred by owner decision, so there is nothing to reconcile against.",
};

export type Classified =
  | { kind: "ok"; command: ProdCommand }
  | { kind: "refused"; reason: string };

export function classifyCommand(name: string | undefined): Classified {
  if (!name) return { kind: "refused", reason: "No command given." };
  const command = PROD_COMMANDS[name];
  if (command) return { kind: "ok", command };
  const elsewhere = NOT_HERE[name];
  if (elsewhere) return { kind: "refused", reason: `${name} is not run through admin:prod. ${elsewhere}` };
  return { kind: "refused", reason: `${name} is not available through admin:prod.` };
}

export interface ProdTarget {
  host: string;
  port: string;
  database: string;
  user: string;
}

export type ProdEnvVerdict = { ok: true; target: ProdTarget } | { ok: false; problems: string[] };

/**
 * Is this `.env.production` safe to run `command` with? Problems name the
 * variable, never its value.
 *
 * `local` is the root `.env`, parsed but not loaded: a production file whose
 * DATABASE_URL is the local one is a copy-paste mistake, refused outright.
 */
export function validateProdEnv(prod: Record<string, string | undefined>, local: Record<string, string | undefined> | null, command: ProdCommand): ProdEnvVerdict {
  const problems: string[] = [];
  const raw = prod.DATABASE_URL?.trim();
  let target: ProdTarget | null = null;

  if (!raw) {
    problems.push("DATABASE_URL is not set in .env.production.");
  } else {
    let u: URL | null = null;
    try {
      u = new URL(raw);
    } catch {
      problems.push("DATABASE_URL in .env.production is not a valid URL.");
    }
    if (u) {
      const host = u.hostname.replace(/^\[|\]$/g, "");
      if (!["postgres:", "postgresql:"].includes(u.protocol)) problems.push("DATABASE_URL must be a postgres:// URL.");
      if (host === "mailroid-db") {
        problems.push("DATABASE_URL uses the Docker hostname mailroid-db, which only resolves on the VPS. Use 127.0.0.1:5433 (the tunnel).");
      } else if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
        problems.push(`DATABASE_URL host must be the tunnel on this machine (127.0.0.1), not ${host}.`);
      }
      if (u.port !== PROD_TUNNEL_PORT) {
        problems.push(
          `DATABASE_URL port must be ${PROD_TUNNEL_PORT} (the SSH tunnel); ${u.port || "the default 5432"} is where a local database listens.`,
        );
      }
      target = { host, port: u.port, database: decodeURIComponent(u.pathname.slice(1)), user: decodeURIComponent(u.username) };
    }
    if (local?.DATABASE_URL?.trim() && local.DATABASE_URL.trim() === raw) {
      problems.push("DATABASE_URL in .env.production is identical to the one in .env (the local database).");
    }
  }

  for (const k of BASE_KEYS) {
    if (!prod[k]?.trim()) problems.push(`${k} is not set in .env.production (checked when the CLI's modules load).`);
  }
  // The file has to say it is production, not merely look like it.
  if (prod.MAILROID_ENV !== undefined && prod.MAILROID_ENV !== "production") {
    problems.push(`MAILROID_ENV in .env.production must be "production".`);
  }
  if (prod.MAILROID_MAILBOX_ALLOWLIST === undefined && prod.MAILROID_MAILBOX_DENYLIST === undefined) {
    problems.push("Neither MAILROID_MAILBOX_ALLOWLIST nor MAILROID_MAILBOX_DENYLIST is set in .env.production (copy the server's).");
  }
  for (const k of command.needs) {
    if (!prod[k]?.trim()) problems.push(`${k} is not set in .env.production (this command needs it).`);
  }
  // The prefix decides which deployment's objects a scan looks at. Scanning the
  // local prefix would find it clean and could seal a production deletion.
  if (command.needs.includes("OBJECT_STORAGE_PREFIX") && prod.OBJECT_STORAGE_PREFIX && prod.OBJECT_STORAGE_PREFIX === local?.OBJECT_STORAGE_PREFIX) {
    problems.push("OBJECT_STORAGE_PREFIX in .env.production is the same as in .env (the local deployment's objects).");
  }
  // No command here deletes an account; a production file that enables
  // deletion is a mistake to stop on, not to carry along.
  if (prod.DELETION_ENABLED?.trim() === "true") {
    problems.push("DELETION_ENABLED=true in .env.production. Deletion stays off; remove it.");
  }

  return problems.length || !target ? { ok: false, problems } : { ok: true, target };
}

/** OS variables a child process needs to start at all. Everything else comes from .env.production. */
const OS_KEYS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData",
  "TERM", "COLORTERM", "LANG", "LC_ALL", "NO_COLOR", "FORCE_COLOR",
];

/**
 * The child's whole environment: the OS basics, then `.env.production`, then
 * the pins. Nothing from the developer's shell or the local `.env` gets in;
 * DOTENV_CONFIG_PATH points every `import "dotenv/config"` in the workspace at
 * `.env.production` too, so no module can fall back to the local file.
 */
export function buildChildEnv(parent: NodeJS.ProcessEnv, prod: Record<string, string>, prodEnvPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of OS_KEYS) if (parent[k] !== undefined) env[k] = parent[k];
  Object.assign(env, prod);
  env.DOTENV_CONFIG_PATH = prodEnvPath;
  env.DELETION_ENABLED = "false";
  env.MAILROID_ADMIN_TARGET = "production";
  env.LOGGER_LEVEL ??= "error";
  return env;
}

export function describeTarget(t: ProdTarget): string {
  return `${t.user ? `${t.user}@` : ""}${t.host}:${t.port}/${t.database}`;
}
