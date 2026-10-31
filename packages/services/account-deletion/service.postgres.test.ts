/**
 * Account deletion against a REAL PostgreSQL server, over several connections.
 *
 * The PGlite tests (service.integration.test.ts and friends) run one
 * connection in one process, so they can't show what happens when two
 * transactions overlap. This file can: the app's own pool, plus independent
 * `pg` clients standing in for other app processes (a sync worker, a sign-in),
 * each holding its own transaction open while deletion runs.
 *
 * Object storage and the ledger go through the REAL adapters (s3DeletionStore,
 * resolveLedger) and the real AWS SDK, against an in-process S3
 * (testing/fake-s3.ts). Google is never called: the seeded users have no
 * Google connection.
 *
 * The in-flight cases (section 5) are why the fence has a writer drain
 * (drain.ts): without it, a write admitted before the fence and still open
 * during the delete survived a COMPLETED deletion.
 *
 * RUN:  DELETION_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mailroid_deletion_test \
 *         pnpm --filter @repo/services test:deletion-pg
 * after applying every migration to that database (drizzle-kit migrate).
 * Skipped when the variable is unset.
 *
 * SAFETY. Refuses any URL that is not localhost, is port 5433 (the production
 * tunnel), or names a database other than `mailroid_deletion_test`, and checks
 * `current_database()` again over the app pool before touching anything. It
 * TRUNCATES every table in that database at the start.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import pg from "pg";

import type { AttachmentCacheConfig } from "../attachments/config.ts";
import { FENCE_TRIGGER_TABLES, INVENTORY } from "./inventory.ts";
import { reconcileLedger, resolveLedger } from "./ledger.ts";
import { DELETE_WAIT_MS, FENCE_STEPS } from "./policy.ts";
import { purgeUserObjects, s3DeletionStore, scanUserPrefix } from "./storage.ts";
import { startFakeS3, type FakeS3 } from "./testing/fake-s3.ts";

const RAW_URL = process.env.DELETION_TEST_DATABASE_URL;
const DB_NAME = "mailroid_deletion_test";
const skip = RAW_URL ? false : "DELETION_TEST_DATABASE_URL is not set";

function guardUrl(raw: string): string {
  const u = new URL(raw);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new Error(`refusing non-local database host ${u.hostname}`);
  if (u.port === "5433") throw new Error("refusing port 5433: that is the production SSH tunnel");
  if (u.pathname !== `/${DB_NAME}`) throw new Error(`refusing database ${u.pathname.slice(1)}: only ${DB_NAME} may be used`);
  return raw;
}

const t = (name: string, fn: () => Promise<void>) => test(name, { skip, timeout: 60_000 }, fn);

let URL_ = "";
let svc: typeof import("./service.ts");
let dbmod: typeof import("@repo/database");
let s3: FakeS3;
const clients: pg.Client[] = [];

// ── Clock, storage, ledger ────────────────────────────────────────────

const T0 = new Date("2026-10-28T10:00:00.000Z");
let clock = T0;
const at = (ms: number) => new Date(T0.getTime() + ms);

const storeCfg = (): AttachmentCacheConfig =>
  ({ endpoint: s3.endpoint, region: "us-east-1", bucket: s3.bucket, accessKeyId: "test", secretAccessKey: "test", prefix: "test" }) as AttachmentCacheConfig;
const ledgerEnv = () => ({
  DELETION_LEDGER_PREFIX: "deletion-ledger",
  OBJECT_STORAGE_ENDPOINT: s3.endpoint,
  OBJECT_STORAGE_REGION: "us-east-1",
  OBJECT_STORAGE_BUCKET: s3.bucket,
  OBJECT_STORAGE_ACCESS_KEY_ID: "test",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "test",
});
let ledgerConfigured = true;
const deps = {
  now: () => clock,
  store: () => s3DeletionStore(storeCfg()),
  ledger: () => resolveLedger(ledgerConfigured ? ledgerEnv() : {}),
  // Short, so the timeout cases run fast. Production uses DRAIN_LOCK_TIMEOUT_MS.
  drainTimeoutMs: 1500,
};

const dev = () => ({ type: "DEVELOPER" as const, userId: "dev-1", email: "dev@mailroid.test" });

// ── Helpers ───────────────────────────────────────────────────────────

const q = async (text: string, params: unknown[] = []) => (await dbmod.pool.query(text, params)).rows;
const n = async (text: string, params: unknown[] = []) => Number((await q(text, params))[0]!.n);
const rowsFor = (table: string, col: string, id: string) => n(`SELECT count(*)::int AS n FROM "${table}" WHERE ${col} = $1`, [id]);

/** An independent connection: another app process, as far as Postgres can tell. */
async function connect(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: URL_ });
  await c.connect();
  clients.push(c);
  return c;
}

const fenced = (re = /TENANT_FENCED/) => (err: Error) => re.test(err.message);

async function seedUser(id: string): Promise<{ email: string; conversationId: string }> {
  const email = `${id}@x.test`;
  await q(`INSERT INTO "user" (id, name, email, platform_role) VALUES ($1, $1, $2, 'USER')`, [id, email]);
  await q(`INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES ($1, $1, $2, now() + interval '1 day', now())`, [`s-${id}`, id]);
  await q(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ($1, 't', $2)`, [`m-${id}`, id]);
  await q(`INSERT INTO gmail_sync_failures (tenant_id, thread_id, source, kind) VALUES ($1, 't', 'test', 'test')`, [id]);
  const [c] = await q(`INSERT INTO conversations (user_id, title) VALUES ($1, 'hi') RETURNING id`, [id]);
  await q(`INSERT INTO assistant_messages (conversation_id, role) VALUES ($1, 'user')`, [c!.id]);
  return { email, conversationId: c!.id as string };
}

async function submit(userId: string) {
  return svc.submitDeletionRequest({ userId, kind: "DEPARTURE", reason: "leaving the company" });
}

async function fence(id: string, email: string) {
  return svc.fenceAccount({ id, actor: dev(), confirmEmail: email, orgConfirmed: false, lastOwnerChoices: {} }, deps);
}

/** Fence at T0 and move the clock to exactly the 12 h mark, deletion allowlisted for this user. */
async function fencedAndEligible(userId: string) {
  const { email } = await seedUser(userId);
  const req = await submit(userId);
  clock = T0;
  const f = await fence(req.id, email);
  assert.ok(f.request.fencedConfirmedAt, `fence confirmed for ${userId}`);
  clock = at(DELETE_WAIT_MS);
  process.env.DELETION_TEST_ALLOWLIST = [process.env.DELETION_TEST_ALLOWLIST, email].filter(Boolean).join(",");
  return { req, email };
}

async function deleteNow(id: string, email: string) {
  return svc.deleteAccount({ id, actor: dev(), confirmEmail: email }, deps);
}

/** Hold the request row locked from another connection so callers queue on it, then release. */
async function holdRequestRow(id: string): Promise<() => Promise<void>> {
  const c = await connect();
  await c.query("BEGIN");
  await c.query(`SELECT 1 FROM account_deletion_request WHERE id = $1 FOR UPDATE`, [id]);
  return async () => {
    await c.query("COMMIT");
  };
}

async function waitForBlocked(min: number) {
  for (let i = 0; i < 100; i++) {
    const waiting = await n(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`,
      [DB_NAME],
    );
    if (waiting >= min) return waiting;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`fewer than ${min} sessions ever blocked`);
}

// ── Setup ─────────────────────────────────────────────────────────────

before(async () => {
  if (skip) return;
  URL_ = guardUrl(RAW_URL!);
  process.env.DATABASE_URL = URL_;
  process.env.CORSAIR_KEK ??= Buffer.alloc(32, 1).toString("base64");
  // Set, not deleted: importing @repo/database loads .env, which would refill an unset variable.
  process.env.DELETION_ENABLED = "false";
  process.env.DELETION_TEST_ALLOWLIST = "";

  dbmod = await import("@repo/database");
  svc = await import("./service.ts");

  const [{ db }] = await q("SELECT current_database() AS db");
  assert.equal(db, DB_NAME, "the app pool must point at the dedicated test database");

  await q(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE format('TRUNCATE %I CASCADE', r.tablename);
    END LOOP; END $$`);
  await q(`INSERT INTO "user" (id, name, email, platform_role) VALUES ('dev-1', 'Dev', 'dev@mailroid.test', 'DEVELOPER')`);

  s3 = await startFakeS3();
});

after(async () => {
  for (const c of clients) await c.end().catch(() => undefined);
  await dbmod?.pool.end().catch(() => undefined);
  await s3?.close();
});

// ═════ 1–2. Migrations and the trigger, on the live database ══════════

t("the pool is on the dedicated database, with every migration applied", async () => {
  const dir = fileURLToPath(new URL("../../database/drizzle/", import.meta.url));
  const journal = JSON.parse(readFileSync(`${dir}meta/_journal.json`, "utf8")) as { entries: unknown[] };
  assert.equal(await n(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`), journal.entries.length);
});

t("the fence trigger is on every inventory table: BEFORE INSERT OR UPDATE, FOR EACH ROW, enabled", async () => {
  const rows = await q(
    `SELECT c.relname AS t, tr.tgtype AS type, tr.tgenabled AS enabled, p.proname AS fn
       FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid JOIN pg_proc p ON p.oid = tr.tgfoid
      WHERE tr.tgname = 'trg_tenant_fence'`,
  );
  assert.deepEqual(rows.map((r) => r.t).sort(), [...FENCE_TRIGGER_TABLES]);
  // tgtype bits: ROW 1 | BEFORE 2 | INSERT 4 | UPDATE 16 — and not DELETE 8.
  for (const r of rows) {
    assert.equal(r.type, 1 | 2 | 4 | 16, `${r.t}: trigger type`);
    assert.equal(r.enabled, "O", `${r.t}: enabled`);
    assert.equal(r.fn, "assert_tenant_write", `${r.t}: function`);
  }
  assert.deepEqual(await svc.fenceTriggerStatus(), { installed: true, missing: [] });
});

t("every live table is in the inventory, and every per-user table without the trigger is deliberately classed", async () => {
  const live = (await q(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`)).map((r) => r.t as string);
  assert.deepEqual(live.filter((x) => !INVENTORY[x]), [], "tables the inventory doesn't know");
  const perUser = (
    await q(
      `SELECT DISTINCT table_name AS t FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('user_id', 'tenant_id', 'subject_id', 'target_user_id')`,
    )
  ).map((r) => r.t as string);
  const unfenced = perUser.filter((x) => !FENCE_TRIGGER_TABLES.includes(x));
  for (const x of unfenced) {
    assert.ok(
      ["RETAINED_SCRUBBED", "OPERATOR_CONTROL", "DELETION_CONTROL"].includes(INVENTORY[x]!.cls),
      `${x} holds per-user rows, has no fence trigger, and is classed ${INVENTORY[x]!.cls}`,
    );
  }
});

t("a disabled trigger is reported missing, so delete would be refused", async () => {
  await q(`ALTER TABLE emails DISABLE TRIGGER trg_tenant_fence`);
  try {
    assert.deepEqual(await svc.fenceTriggerStatus(), { installed: false, missing: ["emails"] });
  } finally {
    await q(`ALTER TABLE emails ENABLE TRIGGER trg_tenant_fence`);
  }
  assert.equal((await svc.fenceTriggerStatus()).installed, true);
});

// ═════ 3. Concurrent fencing ══════════════════════════════════════════

t("five fences of one request, overlapping on real transactions: exactly one wins, the epoch moves once", async () => {
  const { email } = await seedUser("u-race");
  const req = await submit("u-race");
  clock = T0;

  const release = await holdRequestRow(req.id);
  const runs = Array.from({ length: 5 }, () => fence(req.id, email));
  await waitForBlocked(5); // all five are inside their transactions, queued
  await release();
  const results = await Promise.allSettled(runs);

  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(won.length, 1, "exactly one fence succeeds");
  for (const l of lost) assert.equal((l.reason as { code?: string }).code, "CONFLICT", String(l.reason));

  const [epoch] = await q(`SELECT epoch, state, ever_fenced FROM tenant_epoch WHERE tenant_id = 'u-race'`);
  assert.deepEqual(epoch, { epoch: 1, state: "FENCED", ever_fenced: true }, "the losers' epoch bumps rolled back");
  assert.equal(await n(`SELECT count(*)::int AS n FROM account_deletion_event WHERE request_id = $1 AND to_status = 'FENCED'`, [req.id]), 1);
  assert.equal(await n(`SELECT count(*)::int AS n FROM account_deletion_event WHERE request_id = $1 AND type = 'STEP_DONE' AND detail->>'step' = 'writeLedger'`, [req.id]), 1);
  assert.equal(s3.log.filter((l) => l === `PUT PutObject deletion-ledger/${req.id}/FENCED.json`).length, 1, "one ledger write");
  assert.equal(await n(`SELECT count(*)::int AS n FROM account_deletion_event WHERE request_id = $1 AND detail->>'step' = 'drainWriters'`, [req.id]), 1, "one drain");
});

t("fence and withdraw at the same moment: one or the other, never a fenced tenant with a withdrawn request", async () => {
  for (let i = 0; i < 6; i++) {
    const id = `u-fw-${i}`;
    const { email } = await seedUser(id);
    const req = await submit(id);
    const release = await holdRequestRow(req.id);
    // Alternate who queues first so both orders are exercised.
    const a = i % 2 ? svc.withdrawDeletionRequest(id) : fence(req.id, email);
    await waitForBlocked(1);
    const b = i % 2 ? fence(req.id, email) : svc.withdrawDeletionRequest(id);
    await waitForBlocked(2);
    await release();
    const [ra, rb] = await Promise.allSettled([a, b]);
    assert.equal([ra, rb].filter((r) => r.status === "fulfilled").length, 1, `${id}: exactly one wins`);

    const [{ status }] = await q(`SELECT status FROM account_deletion_request WHERE id = $1`, [req.id]);
    const [ep] = await q(`SELECT state FROM tenant_epoch WHERE tenant_id = $1`, [id]);
    if (status === "WITHDRAWN") assert.notEqual(ep?.state, "FENCED", `${id}: withdrawn but fenced`);
    else {
      assert.equal(status, "FENCED");
      assert.equal(ep?.state, "FENCED", `${id}: request fenced but tenant not`);
    }
  }
});

// ═════ 4. Writes after the fence ══════════════════════════════════════

t("after the fence, every kind of write from another connection is rejected", async () => {
  // u-race was fenced above.
  const w = await connect();
  const [{ id: conv }] = await q(`SELECT id FROM conversations WHERE user_id = 'u-race'`);

  await assert.rejects(w.query(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('late', 't', 'u-race')`), fenced());
  await assert.rejects(w.query(`UPDATE emails SET thread_id = 'x' WHERE user_id = 'u-race'`), fenced());
  await assert.rejects(w.query(`INSERT INTO gmail_sync_failures (tenant_id, thread_id, source, kind) VALUES ('u-race', 't2', 'x', 'x')`), fenced());
  await assert.rejects(w.query(`INSERT INTO assistant_messages (conversation_id, role) VALUES ($1, 'user')`, [conv]), fenced(), "via parent");
  await assert.rejects(w.query(`INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES ('s-new', 's-new', 'u-race', now() + interval '1 day', now())`), fenced(), "new sign-in");
  await assert.rejects(w.query(`UPDATE "user" SET name = 'renamed' WHERE id = 'u-race'`), fenced());

  // The deletion capability opens exactly its own tenant, nobody else's.
  await w.query("BEGIN");
  await w.query(`SELECT set_config('mailroid.deletion_capability', 'someone-else', true)`);
  await assert.rejects(w.query(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('cap', 't', 'u-race')`), fenced());
  await w.query("ROLLBACK");

  // Unfenced tenants carry on; DELETE is never blocked.
  await seedUser("u-bystander");
  await w.query(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('ok', 't', 'u-bystander')`);
  await w.query(`UPDATE emails SET thread_id = 'y' WHERE user_id = 'u-bystander'`);
  await w.query(`DELETE FROM gmail_sync_failures WHERE tenant_id = 'u-race'`);

  assert.equal(await svc.isTenantFenced("u-race"), true);
  assert.equal(await svc.isTenantFenced("u-bystander"), false);
  assert.equal(await rowsFor("session", "user_id", "u-race"), 0, "sessions revoked at fence");
});

// ═════ 5. Writes already in progress when the fence lands: the drain ══

/** Sessions of this database waiting on a lock right now. */
const lockWaiters = () =>
  q(`SELECT left(query, 60) AS query FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [DB_NAME]);

t("a write admitted before the fence and committed while the drain waits: the fence waits for it, then it is purged", async () => {
  await seedUser("u-drain-commit");
  const w = await connect();
  await w.query("BEGIN");
  await w.query(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('in-flight', 't', 'u-drain-commit')`);

  const req = await submit("u-drain-commit");
  clock = T0;
  const fencing = fence(req.id, "u-drain-commit@x.test");
  await waitForBlocked(1);
  assert.match((await lockWaiters())[0]!.query, /LOCK TABLE "emails" IN SHARE MODE/, "the drain is waiting on the open writer");
  await new Promise((r) => setTimeout(r, 300));
  await w.query("COMMIT"); // lands after the fence, before the drain lets go

  const f = await fencing;
  assert.equal(f.steps.drainWriters!.status, "DONE");
  assert.ok((f.steps.drainWriters!.detail?.slowMs as Record<string, number>).emails! >= 250, "the wait on emails is recorded");
  assert.ok(f.request.fencedConfirmedAt);
  assert.equal(await rowsFor("emails", "user_id", "u-drain-commit"), 2, "the late row is there");

  clock = at(DELETE_WAIT_MS);
  process.env.DELETION_TEST_ALLOWLIST += ",u-drain-commit@x.test";
  const res = await deleteNow(req.id, "u-drain-commit@x.test");
  assert.equal(res.request.status, "COMPLETED");
  assert.equal(await rowsFor("emails", "user_id", "u-drain-commit"), 0);
});

t("a writer still open past the timeout: drain FAILS naming the table, no 12 h clock, delete refused; retry recovers", async () => {
  await seedUser("u-drain-open");
  const w = await connect();
  await w.query("BEGIN");
  await w.query(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('open-1', 't', 'u-drain-open')`);
  await w.query(`INSERT INTO gmail_sync_failures (tenant_id, thread_id, source, kind) VALUES ('u-drain-open', 'open', 'x', 'x')`);

  const req = await submit("u-drain-open");
  const email = "u-drain-open@x.test";
  clock = T0;
  let f = await fence(req.id, email);
  const d = f.steps.drainWriters!;
  assert.equal(d.status, "FAILED");
  assert.match(d.error!, /"emails".*lock_timeout/);
  assert.deepEqual([d.detail?.table, d.detail?.pgCode], ["emails", "55P03"]);
  assert.equal(f.steps.revokeSessions!.status, "DONE", "the other steps still ran");
  assert.equal(f.request.fencedConfirmedAt, null, "not confirmed");
  assert.equal(f.request.deleteEligibleAt, null, "the 12 h clock has not started");
  const [ev] = await q(
    `SELECT detail FROM account_deletion_event WHERE request_id = $1 AND type = 'STEP_FAILED' AND detail->>'step' = 'drainWriters'`,
    [req.id],
  );
  assert.equal(ev!.detail.table, "emails", "the failed table is in the history");
  assert.match(ev!.detail.error, /lock_timeout/);

  // However long we wait, and whatever is accepted, it can't be deleted.
  clock = at(30 * 24 * 3600_000);
  process.env.DELETION_TEST_ALLOWLIST += `,${email}`;
  await assert.rejects(deleteNow(req.id, email), (e: { code?: string }) => e.code === "FENCE_NOT_CONFIRMED");
  await assert.rejects(
    svc.deleteAccount({ id: req.id, actor: dev(), confirmEmail: email, acceptUnresolved: ["drainWriters"], acceptReason: "x" }, deps),
    (e: { code?: string }) => e.code === "FENCE_NOT_CONFIRMED" || e.code === "CANNOT_ACCEPT",
  );

  // Retry while still open: fails again, honestly.
  f = await svc.runFenceSteps({ id: req.id, actor: dev() }, deps);
  assert.equal(f.steps.drainWriters!.status, "FAILED");
  assert.equal(f.steps.drainWriters!.attempts, 2);

  // The writer finishes; the retry drains, and the clock starts now.
  await w.query("COMMIT");
  const retryAt = at(31 * 24 * 3600_000);
  clock = retryAt;
  f = await svc.runFenceSteps({ id: req.id, actor: dev() }, deps);
  assert.equal(f.steps.drainWriters!.status, "DONE");
  assert.equal(f.steps.drainWriters!.attempts, 3);
  assert.equal(f.request.fencedConfirmedAt!.toISOString(), retryAt.toISOString());

  clock = new Date(retryAt.getTime() + DELETE_WAIT_MS - 1);
  await assert.rejects(deleteNow(req.id, email), (e: { code?: string }) => e.code === "TOO_EARLY");
  clock = new Date(retryAt.getTime() + DELETE_WAIT_MS);
  const res = await deleteNow(req.id, email);
  assert.equal(res.request.status, "COMPLETED");

  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(
    [await rowsFor("emails", "user_id", "u-drain-open"), await rowsFor("gmail_sync_failures", "tenant_id", "u-drain-open")],
    [0, 0],
    "no pre-fence write exists after COMPLETED",
  );
});

t("a writer arriving during the drain queues behind it, then meets the trigger", async () => {
  await seedUser("u-drain-queue");
  await seedUser("u-drain-neighbour");
  const w1 = await connect();
  await w1.query("BEGIN");
  await w1.query(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('pre', 't', 'u-drain-queue')`);

  const req = await submit("u-drain-queue");
  clock = T0;
  const fencing = fence(req.id, "u-drain-queue@x.test");
  await waitForBlocked(1);

  const w2 = await connect();
  const w3 = await connect();
  const late = w2.query(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('post', 't', 'u-drain-queue')`);
  const neighbour = w3.query(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('n', 't', 'u-drain-neighbour')`);
  late.catch(() => undefined); // asserted below; keeps it from counting as unhandled meanwhile
  await waitForBlocked(3); // the drain, and both new writers queued behind it
  await w1.query("COMMIT");

  await assert.rejects(late, fenced(), "post-fence write rejected once the queue moves");
  await neighbour; // other tenants only waited briefly
  const f = await fencing;
  assert.equal(f.steps.drainWriters!.status, "DONE");
  assert.ok(f.request.fencedConfirmedAt);
});

t("an open writer on a table with an FK to user fails the drain too, so delete can never hang on it", async () => {
  await seedUser("u-drain-fk");
  const w = await connect();
  await w.query("BEGIN");
  await w.query(`INSERT INTO conversations (user_id, title) VALUES ('u-drain-fk', 'open')`);

  const req = await submit("u-drain-fk");
  clock = T0;
  let f = await fence(req.id, "u-drain-fk@x.test");
  assert.equal(f.steps.drainWriters!.status, "FAILED");
  assert.equal(f.steps.drainWriters!.detail?.table, "conversations");

  await w.query("COMMIT");
  f = await svc.runFenceSteps({ id: req.id, actor: dev() }, deps);
  assert.equal(f.steps.drainWriters!.status, "DONE");
  clock = new Date(f.request.fencedConfirmedAt!.getTime() + DELETE_WAIT_MS);
  process.env.DELETION_TEST_ALLOWLIST += ",u-drain-fk@x.test";
  const res = await deleteNow(req.id, "u-drain-fk@x.test");
  assert.equal(res.request.status, "COMPLETED");
  assert.equal(await rowsFor("conversations", "user_id", "u-drain-fk"), 0);
});

// ═════ 6. Storage through the real S3 adapter ═════════════════════════

t("storage: every page of objects and multipart uploads is purged, and nothing of anyone else's", async () => {
  const store = s3DeletionStore(storeCfg());
  for (let i = 0; i < 10; i++) s3.objects.set(`test/attachments/u-s1/obj-${i}`, Buffer.from("x"));
  s3.objects.set("test/attachments/u-s10/neighbour", Buffer.from("x")); // shares the "u-s1" string prefix
  s3.objects.set("test/attachments/u-other/b", Buffer.from("x"));
  for (let i = 0; i < 7; i++) s3.uploads.push({ key: `test/attachments/u-s1/part-${i}`, uploadId: `up-${i}` });
  s3.uploads.push({ key: "test/attachments/u-other/p", uploadId: "up-other" });

  const res = await purgeUserObjects(store, "u-s1", []);
  assert.deepEqual(res, { complete: true, deleted: 10, abortedUploads: 7, failures: [] });
  assert.ok(s3.objects.has("test/attachments/u-s10/neighbour"));
  assert.ok(s3.objects.has("test/attachments/u-other/b"));
  assert.deepEqual(s3.uploads.map((u) => u.uploadId), ["up-other"]);
  assert.ok(s3.log.filter((l) => l === "GET ListObjectsV2 test/attachments/u-s1/").length >= 4, "10 objects at 3 a page = 4 pages");

  const scan = await scanUserPrefix(store, "u-s1");
  assert.equal(scan.complete, true);
  assert.equal(scan.objects + scan.uploads, 0);
});

t("storage: a truncated listing with no token fails closed", async () => {
  const store = s3DeletionStore(storeCfg());
  for (let i = 0; i < 5; i++) s3.objects.set(`test/attachments/u-s2/o-${i}`, Buffer.from("x"));
  s3.fail.truncatedWithoutToken = true;
  try {
    const res = await purgeUserObjects(store, "u-s2", []);
    assert.equal(res.complete, false);
    assert.match(res.failures[0]!.error, /truncated without a continuation token/);
    const scan = await scanUserPrefix(store, "u-s2");
    assert.equal(scan.complete, false, "a scan that couldn't finish is never 'empty'");
  } finally {
    s3.fail.truncatedWithoutToken = false;
  }
});

t("storage: a refused delete and a failed multipart listing are reported, never complete", async () => {
  const store = s3DeletionStore(storeCfg());
  for (let i = 0; i < 4; i++) s3.objects.set(`test/attachments/u-s3/o-${i}`, Buffer.from("x"));
  s3.fail.deleteKeys.add("test/attachments/u-s3/o-2");
  s3.fail.uploadList = true;
  try {
    const res = await purgeUserObjects(store, "u-s3", []);
    assert.equal(res.complete, false);
    assert.equal(res.deleted, 3);
    const byKey = Object.fromEntries(res.failures.map((f) => [f.key, f.error]));
    assert.match(byKey["test/attachments/u-s3/o-2"]!, /AccessDenied.*HTTP 403/);
    assert.match(byKey["test/attachments/u-s3/"]!, /multipart listing failed/);
  } finally {
    s3.fail.deleteKeys.clear();
    s3.fail.uploadList = false;
  }
});

// ═════ 7. The ledger through the real S3 adapter ══════════════════════

t("ledger: the fence entry was written, read back, and lists", async () => {
  const [{ id }] = await q(`SELECT id FROM account_deletion_request WHERE user_id = 'u-race'`);
  const key = `deletion-ledger/${id}/FENCED.json`;
  assert.ok(s3.log.includes(`GET GetObject ${key}`), "read back after write");
  const entry = JSON.parse(s3.objects.get(key)!.toString());
  assert.equal(entry.event, "FENCED");
  assert.equal(entry.userId, "u-race");
  assert.equal(JSON.stringify(entry).includes("@"), false, "no email address in the ledger");
  const listed = await resolveLedger(ledgerEnv()).list();
  assert.ok(listed.some((e) => e.requestId === id && e.event === "FENCED"));
});

t("ledger: unset is DEFERRED_BY_OWNER (never DONE); refused PUT and read-back mismatch each FAIL; fence-retry recovers", async () => {
  const { email } = await seedUser("u-ledger");
  const req = await submit("u-ledger");
  clock = T0;

  ledgerConfigured = false;
  let f = await fence(req.id, email);
  ledgerConfigured = true;
  // No ledger asked for: the owner's deferral, recorded as such — not a write.
  assert.equal(f.steps.writeLedger!.status, "DEFERRED_BY_OWNER");
  assert.ok(f.request.fencedConfirmedAt, "the ledger doesn't confirm the fence");
  // A deferred step is re-evaluated by fence-retry: once a ledger is configured it is written.

  s3.fail.put = true;
  f = await svc.runFenceSteps({ id: req.id, actor: dev() }, deps);
  s3.fail.put = false;
  assert.equal(f.steps.writeLedger!.status, "FAILED");
  assert.match(f.steps.writeLedger!.error!, /AccessDenied/);

  s3.fail.corruptGet = true;
  f = await svc.runFenceSteps({ id: req.id, actor: dev() }, deps);
  s3.fail.corruptGet = false;
  assert.equal(f.steps.writeLedger!.status, "FAILED");
  assert.match(f.steps.writeLedger!.error!, /read-back mismatch/);

  clock = at(DELETE_WAIT_MS);
  process.env.DELETION_TEST_ALLOWLIST += `,${email}`;
  await assert.rejects(deleteNow(req.id, email), (e: { code?: string }) => e.code === "STEPS_UNRESOLVED");

  f = await svc.runFenceSteps({ id: req.id, actor: dev() }, deps);
  assert.equal(f.steps.writeLedger!.status, "DONE");
  assert.equal(f.steps.writeLedger!.attempts, 4);
  const res = await deleteNow(req.id, email);
  assert.equal(res.request.status, "COMPLETED");
  assert.ok(s3.objects.has(`deletion-ledger/${req.id}/COMPLETED.json`));
});

t("ledger: after a simulated restore, reconcile finds the resurrected user and the rolled-back request", async () => {
  const [done] = await q(`SELECT id, user_id FROM account_deletion_request WHERE user_id = 'u-ledger'`);
  // A restore from before completion brings the user back. pg_restore loads
  // with triggers off, which is the only way past the fence; do the same.
  const r0 = await connect();
  await r0.query("BEGIN");
  await r0.query("SET LOCAL session_replication_role = replica");
  await r0.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Back', 'back@x.test')`, [done!.user_id]);
  await r0.query("COMMIT");
  const entries = await resolveLedger(ledgerEnv()).list();
  const users = new Set((await q(`SELECT id FROM "user"`)).map((r) => r.id));
  const status = new Map((await q(`SELECT id, status FROM account_deletion_request`)).map((r) => [r.id, r.status]));
  const r = reconcileLedger(entries, { userExists: (id) => users.has(id), requestStatus: (id) => status.get(id) ?? null });
  assert.ok(r.resurrected.some((e) => e.userId === "u-ledger"));
  await q(`DELETE FROM "user" WHERE id = $1`, [done!.user_id]);
});

t("ledger: a failed COMPLETED write is recorded as an event, not passed over", async () => {
  const { req, email } = await fencedAndEligible("u-ledger-late");
  s3.fail.put = true;
  try {
    const res = await deleteNow(req.id, email);
    assert.equal(res.request.status, "COMPLETED");
  } finally {
    s3.fail.put = false;
  }
  const ev = await q(`SELECT type, detail FROM account_deletion_event WHERE request_id = $1 AND type LIKE 'LEDGER%'`, [req.id]);
  assert.deepEqual(ev.map((e) => e.type), ["LEDGER_WRITE_FAILED"]);
  assert.match(ev[0]!.detail.error, /AccessDenied/);
});

// ═════ 8. The 12-hour gate ════════════════════════════════════════════

t("12 h: stored to the millisecond, refused a minute early, allowed at the mark and long after", async () => {
  const { email } = await seedUser("u-clock");
  const req = await submit("u-clock");
  clock = new Date("2026-10-28T23:30:00.123Z"); // crosses midnight UTC
  await fence(req.id, email);
  const [r] = await q(`SELECT fenced_confirmed_at, delete_eligible_at FROM account_deletion_request WHERE id = $1`, [req.id]);
  assert.equal(r!.fenced_confirmed_at.toISOString(), "2026-10-28T23:30:00.123Z");
  assert.equal(r!.delete_eligible_at.getTime() - r!.fenced_confirmed_at.getTime(), DELETE_WAIT_MS);

  const attempt = async (ms: number) => {
    clock = new Date(r!.fenced_confirmed_at.getTime() + ms);
    return deleteNow(req.id, email).then(
      () => "deleted",
      (e: { code?: string }) => e.code,
    );
  };
  assert.equal(await attempt(DELETE_WAIT_MS - 60_000), "TOO_EARLY");
  assert.equal(await attempt(DELETE_WAIT_MS - 1), "TOO_EARLY");
  // Not allowlisted, so passing the clock gate shows up as the next gate.
  assert.equal(await attempt(DELETE_WAIT_MS), "DELETION_DISABLED");
  assert.equal(await attempt(30 * 24 * 3600_000), "DELETION_DISABLED");
  assert.equal(await n(`SELECT count(*)::int AS n FROM account_deletion_event WHERE request_id = $1 AND type = 'DELETE_REFUSED'`, [req.id]), 4);
  const [{ status }] = await q(`SELECT status FROM account_deletion_request WHERE id = $1`, [req.id]);
  assert.equal(status, "FENCED", "refusals change nothing");
});

// ═════ 9. Retry, cancel, audit ════════════════════════════════════════

t("retry: a storage failure stops before any row is deleted; retry finishes it", async () => {
  const { req, email } = await fencedAndEligible("u-retry");
  for (let i = 0; i < 5; i++) s3.objects.set(`test/attachments/u-retry/o-${i}`, Buffer.from("x"));
  s3.fail.deleteKeys.add("test/attachments/u-retry/o-3");

  const first = await deleteNow(req.id, email);
  assert.equal(first.request.status, "PURGE_FAILED");
  assert.match(first.request.lastError!, /test\/attachments\/u-retry\/o-3: AccessDenied/);
  assert.equal(await rowsFor("emails", "user_id", "u-retry"), 1, "database untouched: storage goes first");
  assert.equal(await rowsFor("user", "id", "u-retry"), 1);

  await assert.rejects(svc.cancelFence({ id: req.id, actor: dev(), reason: "x" }, deps), (e: { code?: string }) => e.code === "WRONG_STATUS");

  s3.fail.deleteKeys.clear();
  const second = await svc.retryDeletion({ id: req.id, actor: dev(), confirmEmail: email }, deps);
  assert.equal(second.request.status, "COMPLETED");
  assert.equal([...s3.objects.keys()].filter((k) => k.startsWith("test/attachments/u-retry/")).length, 0);
  assert.equal(await rowsFor("user", "id", "u-retry"), 0);
  await assert.rejects(svc.retryDeletion({ id: req.id, actor: dev(), confirmEmail: email }, deps), (e: { code?: string }) => e.code === "CONFIRMATION_MISMATCH" || e.code === "WRONG_STATUS");
});

t("cancel: unfences, writes work again from any connection, the pause is lifted; nothing after it", async () => {
  const { email } = await seedUser("u-cancel");
  const req = await submit("u-cancel");
  clock = T0;
  await fence(req.id, email);
  assert.equal(await rowsFor("sync_pauses", "tenant_id", "u-cancel"), 1);

  const c = await svc.cancelFence({ id: req.id, actor: dev(), reason: "the user changed their mind by email" }, deps);
  assert.equal(c.request.status, "CANCELLED");
  assert.ok(!c.recoveryNeeded.some((x) => x.startsWith("Ledger not updated")), c.recoveryNeeded.join(" | "));
  assert.ok(s3.objects.has(`deletion-ledger/${req.id}/CANCELLED.json`));

  const [ep] = await q(`SELECT epoch, state FROM tenant_epoch WHERE tenant_id = 'u-cancel'`);
  assert.deepEqual(ep, { epoch: 2, state: "ACTIVE" });
  assert.equal(await rowsFor("sync_pauses", "tenant_id", "u-cancel"), 0);
  const w = await connect();
  await w.query(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('after-cancel', 't', 'u-cancel')`);
  await w.query(`INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES ('s-back', 's-back', 'u-cancel', now() + interval '1 day', now())`);

  await assert.rejects(svc.cancelFence({ id: req.id, actor: dev(), reason: "again" }, deps), (e: { code?: string }) => e.code === "WRONG_STATUS");
  clock = at(DELETE_WAIT_MS);
  await assert.rejects(deleteNow(req.id, email), (e: { code?: string }) => e.code === "WRONG_STATUS");
  const again = await submit("u-cancel");
  assert.equal(again.status, "SUBMITTED", "a new request can be made after a cancel");
});

t("audit: the whole history is recorded in order, with the right actor, and minimised at completion", async () => {
  const [req] = await q(`SELECT id, email, email_hash, details, status FROM account_deletion_request WHERE user_id = 'u-retry'`);
  assert.equal(req!.status, "COMPLETED");
  assert.equal(req!.email, null);
  assert.equal(req!.details, null);

  const ev = await q(
    `SELECT type, to_status, actor_type, actor_email FROM account_deletion_event WHERE request_id = $1 ORDER BY occurred_at, id`,
    [req!.id],
  );
  const shape = ev.map((e) => (e.to_status ? `${e.type}→${e.to_status}` : e.type));
  const expectInOrder = [
    "SUBMITTED→SUBMITTED",
    "TRANSITION→FENCED",
    "FENCE_CONFIRMED",
    "TRANSITION→PURGING",
    "STORAGE_PURGED",
    "TRANSITION→PURGE_FAILED",
    "TRANSITION→PURGING",
    "STORAGE_PURGED",
    "DATABASE_PURGED",
    "TRANSITION→VERIFYING",
    "TRANSITION→COMPLETED",
    "LEDGER_COMPLETED",
  ];
  let i = 0;
  for (const s of shape) if (s === expectInOrder[i]) i++;
  assert.equal(i, expectInOrder.length, `history out of order or incomplete:\n${shape.join("\n")}`);
  assert.equal(shape.filter((s) => s.startsWith("STEP_")).length, FENCE_STEPS.length, "one record per fence step");

  const by = (s: string) => ev.find((e) => (e.to_status ? `${e.type}→${e.to_status}` : e.type) === s)!;
  assert.equal(by("SUBMITTED→SUBMITTED").actor_type, "USER");
  assert.equal(by("SUBMITTED→SUBMITTED").actor_email, req!.email_hash, "the user's address is replaced by its hash");
  assert.equal(by("TRANSITION→FENCED").actor_email, "dev@mailroid.test", "the developer stays named");
  assert.equal(by("TRANSITION→COMPLETED").actor_type, "SYSTEM");
  assert.equal(JSON.stringify(ev).includes("u-retry@x.test"), false, "the address appears nowhere in the history");

  await assert.rejects(
    q(`INSERT INTO account_deletion_event (request_id, type, actor_type) VALUES ($1, 'X', 'DEVELOPER')`, [req!.id]),
    /account_deletion_event_actor_check/,
  );
});

// ═════ 10. The late-object detector (rehearsal of runbook "After") ═════

t("detector: clean prefix stays COMPLETED; a planted object raises an incident and is NOT deleted; remediation seals it", async () => {
  const { req, email } = await fencedAndEligible("u-late-object");
  const done = await deleteNow(req.id, email);
  assert.equal(done.request.status, "COMPLETED");
  const system = { type: "SYSTEM" as const };

  // The hourly detector calls exactly this, as SYSTEM.
  let v = await svc.verifyStorage({ id: req.id, actor: system }, deps);
  assert.equal(v.request.status, "COMPLETED", "healthy");
  assert.equal(v.scan.complete, true);

  // A controlled late object under the deleted user's prefix.
  const key = "test/attachments/u-late-object/late-test-object";
  s3.objects.set(key, Buffer.from("planted"));
  v = await svc.verifyStorage({ id: req.id, actor: system }, deps);
  assert.equal(v.request.status, "INTEGRITY_INCIDENT");
  assert.deepEqual(v.scan.sampleKeys, [key]);
  assert.ok(s3.objects.has(key), "the detector never deletes");
  assert.equal(s3.log.filter((l) => l === `DELETE DeleteObject ${key}`).length, 0);
  const [inc] = await q(`SELECT detail FROM account_deletion_event WHERE request_id = $1 AND to_status = 'INTEGRITY_INCIDENT'`, [req.id]);
  assert.deepEqual(inc!.detail.sampleKeys, [key]);

  // Running again doesn't escalate or delete; it stays an incident.
  v = await svc.verifyStorage({ id: req.id, actor: system }, deps);
  assert.equal(v.request.status, "INTEGRITY_INCIDENT");
  assert.ok(s3.objects.has(key));

  // Documented remediation: account:remediate, then account:verify-storage after T_last.
  const r = await svc.remediateIncident({ id: req.id, actor: dev() }, deps);
  assert.equal(r.request.status, "AWAITING_SEAL");
  assert.equal(r.purge.deleted, 1);
  assert.equal(s3.objects.has(key), false);
  v = await svc.verifyStorage({ id: req.id, actor: dev() }, deps);
  assert.equal(v.request.status, "AWAITING_SEAL", "a scan before the new T_last doesn't seal");
  clock = new Date(r.request.tLast!.getTime() + 1);
  v = await svc.verifyStorage({ id: req.id, actor: dev() }, deps);
  assert.equal(v.request.status, "COMPLETED");
});
