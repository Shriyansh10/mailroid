import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildChildEnv, classifyCommand, PROD_COMMANDS, validateProdEnv } from "./prod-env.ts";

const TUNNEL = "postgresql://postgres:s3cret@127.0.0.1:5433/mailroid";
const BASE = {
  MAILROID_ENV: "production",
  MAILROID_MAILBOX_DENYLIST: "",
  CORSAIR_INSTANCE_ID: "i",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "s",
  GMAIL_PUBSUB_TOPIC: "t",
  AI_API_KEY: "a",
  EMBEDDINGS_API_KEY: "e",
};
const LOCAL = { DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/mailroid", OBJECT_STORAGE_PREFIX: "dev" };
const STORAGE = {
  OBJECT_STORAGE_ENDPOINT: "https://sgp1.digitaloceanspaces.com",
  OBJECT_STORAGE_REGION: "sgp1",
  OBJECT_STORAGE_BUCKET: "b",
  OBJECT_STORAGE_ACCESS_KEY_ID: "k",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "s",
  OBJECT_STORAGE_PREFIX: "prod",
};
const cmd = (name: string) => PROD_COMMANDS[name]!;
const problems = (v: ReturnType<typeof validateProdEnv>) => (v.ok ? [] : v.problems);

test("only the recovery and lookup commands are allowed; the lifecycle stays in the panel", () => {
  for (const name of ["account:verify-storage", "account:remediate", "account:hold", "account:retention", "account:reregistrations", "account:review-resolve"]) {
    assert.equal(classifyCommand(name).kind, "ok", name);
  }
  for (const name of ["account:fence", "account:delete", "account:retry", "account:cancel", "account:reject", "account:fence-retry"]) {
    const c = classifyCommand(name);
    assert.ok(c.kind === "refused" && /developer panel/.test(c.reason), name);
  }
  const ledger = classifyCommand("account:ledger-reconcile");
  assert.ok(ledger.kind === "refused" && /deferred by owner decision/.test(ledger.reason));
  assert.equal(classifyCommand("gmail:resync").kind, "refused");
  assert.equal(classifyCommand(undefined).kind, "refused");
});

test("state-changing commands need the typed confirmation; retention only with --execute", () => {
  for (const name of ["account:verify-storage", "account:remediate", "account:hold", "account:review-resolve"]) {
    assert.equal(cmd(name).mutates([]), true, name);
  }
  assert.equal(cmd("account:reregistrations").mutates([]), false);
  assert.equal(cmd("account:retention").mutates([]), false);
  assert.equal(cmd("account:retention").mutates(["--execute", "--confirm", "3"]), true);
});

test("the tunnel URL is accepted, and the target is described without the password", () => {
  const v = validateProdEnv({ ...BASE, DATABASE_URL: TUNNEL }, LOCAL, cmd("account:hold"));
  assert.ok(v.ok, problems(v).join("; "));
  assert.deepEqual(v.target, { host: "127.0.0.1", port: "5433", database: "mailroid", user: "postgres" });
});

test("anything that could be the local database is refused", () => {
  const hold = cmd("account:hold");
  assert.match(problems(validateProdEnv({}, LOCAL, hold)).join(), /DATABASE_URL is not set/);
  assert.match(problems(validateProdEnv({ DATABASE_URL: LOCAL.DATABASE_URL }, LOCAL, hold)).join(), /port must be 5433/);
  assert.match(problems(validateProdEnv({ DATABASE_URL: LOCAL.DATABASE_URL }, LOCAL, hold)).join(), /identical to the one in \.env/);
  assert.match(problems(validateProdEnv({ DATABASE_URL: "postgresql://u:p@localhost/mailroid" }, LOCAL, hold)).join(), /default 5432/);
  assert.match(problems(validateProdEnv({ DATABASE_URL: "postgresql://u:p@mailroid-db:5432/mailroid" }, LOCAL, hold)).join(), /mailroid-db/);
  assert.match(problems(validateProdEnv({ DATABASE_URL: "postgresql://u:p@db.example.com:5433/m" }, LOCAL, hold)).join(), /tunnel on this machine/);
  assert.match(problems(validateProdEnv({ DATABASE_URL: "not a url" }, LOCAL, hold)).join(), /not a valid URL/);
  assert.match(problems(validateProdEnv({ DATABASE_URL: "mysql://u:p@127.0.0.1:5433/m" }, LOCAL, hold)).join(), /postgres/);
});

test("problems name variables, never their values", () => {
  const all = problems(validateProdEnv({ DATABASE_URL: "postgresql://u:s3cret@db.example.com:5432/m", OBJECT_STORAGE_SECRET_ACCESS_KEY: "topsecret" }, LOCAL, cmd("account:remediate"))).join("\n");
  assert.doesNotMatch(all, /s3cret|topsecret/);
});

test("storage commands need every OBJECT_STORAGE_* value, and not the local prefix", () => {
  const verify = cmd("account:verify-storage");
  assert.match(problems(validateProdEnv({ ...BASE, DATABASE_URL: TUNNEL }, LOCAL, verify)).join(), /OBJECT_STORAGE_BUCKET is not set/);
  assert.ok(validateProdEnv({ ...BASE, DATABASE_URL: TUNNEL, ...STORAGE }, LOCAL, verify).ok);
  assert.match(problems(validateProdEnv({ ...BASE, DATABASE_URL: TUNNEL, ...STORAGE, OBJECT_STORAGE_PREFIX: "dev" }, LOCAL, verify)).join(), /same as in \.env/);
});

test("the file must say it is production, and carry what the services read at import", () => {
  const hold = cmd("account:hold");
  assert.match(problems(validateProdEnv({ ...BASE, MAILROID_ENV: "local", DATABASE_URL: TUNNEL }, LOCAL, hold)).join(), /must be "production"/);
  const { GOOGLE_CLIENT_SECRET: _, ...noSecret } = BASE;
  assert.match(problems(validateProdEnv({ ...noSecret, DATABASE_URL: TUNNEL }, LOCAL, hold)).join(), /GOOGLE_CLIENT_SECRET is not set/);
  const { MAILROID_MAILBOX_DENYLIST: __, ...noPolicy } = BASE;
  assert.match(problems(validateProdEnv({ ...noPolicy, DATABASE_URL: TUNNEL }, LOCAL, hold)).join(), /MAILBOX_ALLOWLIST nor/);
});

test("a production file that enables deletion is refused", () => {
  assert.match(problems(validateProdEnv({ ...BASE, DATABASE_URL: TUNNEL, DELETION_ENABLED: "true" }, LOCAL, cmd("account:hold"))).join(), /DELETION_ENABLED=true/);
});

test("the child sees the OS basics and .env.production — nothing from the shell or the local .env", () => {
  const parent = { PATH: "/bin", SystemRoot: "C:\\Windows", DATABASE_URL: LOCAL.DATABASE_URL, DELETION_ENABLED: "true", OBJECT_STORAGE_PREFIX: "dev", GOOGLE_CLIENT_SECRET: "x" };
  const env = buildChildEnv(parent, { DATABASE_URL: TUNNEL, OBJECT_STORAGE_PREFIX: "prod" }, "/repo/.env.production");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.DATABASE_URL, TUNNEL);
  assert.equal(env.OBJECT_STORAGE_PREFIX, "prod");
  assert.equal(env.GOOGLE_CLIENT_SECRET, undefined, "shell secrets don't leak in");
  assert.equal(env.DELETION_ENABLED, "false", "deletion pinned off");
  assert.equal(env.DOTENV_CONFIG_PATH, "/repo/.env.production", "dotenv/config can only load the production file");
  assert.equal(env.MAILROID_ADMIN_TARGET, "production");
});
