/**
 * Legal hold against retention expiry, on a REAL PostgreSQL server over
 * several connections — the race PGlite (one connection) cannot show.
 *
 * A hold must never be bypassed by a sweep running at the same moment. Each
 * case orders the two sides deterministically: the sweep's test hooks pause
 * it just before or just after it takes its locks, and the test waits until
 * the other side is observably blocked (pg_stat_activity) before letting go.
 * No sleeps decide an outcome.
 *
 *   1. The sweep holds the lock; a hold arrives. The hold waits, the expiry
 *      completes, then the hold is accepted.
 *   2. A hold commits before the sweep locks. The sweep refuses the item.
 *   3. A hold's transaction holds the row when the sweep tries to lock. The
 *      sweep waits; the hold commits; the sweep refuses the item.
 *   4. As 3, for a suppression marker.
 *
 * RUN: with service.postgres.test.ts (pnpm test:deletion-pg); same safety
 * rules — localhost only, never port 5433, database mailroid_deletion_test
 * only. It truncates that database's tables at the start.
 */

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import pg from "pg";

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
let ret: typeof import("./retention.ts");
let dbmod: typeof import("@repo/database");
const clients: pg.Client[] = [];

const dev = () => ({ type: "DEVELOPER" as const, userId: "dev-hold", email: "dev-hold@mailroid.test" });
const q = async (text: string, params: unknown[] = []) => (await dbmod.pool.query(text, params)).rows;
const LATER = () => new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);

before(async () => {
  if (skip) return;
  URL_ = guardUrl(RAW_URL!);
  process.env.DATABASE_URL = URL_;
  process.env.CORSAIR_KEK ??= Buffer.alloc(32, 1).toString("base64");
  process.env.DELETION_ENABLED = "false";
  process.env.DELETION_TEST_ALLOWLIST = "";
  dbmod = await import("@repo/database");
  svc = await import("./service.ts");
  ret = await import("./retention.ts");
  const [{ db }] = await q("SELECT current_database() AS db");
  assert.equal(db, DB_NAME, "the app pool must point at the dedicated test database");
  await q(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE format('TRUNCATE %I CASCADE', r.tablename);
    END LOOP; END $$`);
  await q(`INSERT INTO "user" (id, name, email, platform_role) VALUES ('dev-hold', 'Dev', 'dev-hold@mailroid.test', 'DEVELOPER')`);
});

after(async () => {
  for (const c of clients) await c.end().catch(() => undefined);
  await dbmod?.pool.end().catch(() => undefined);
});

async function connect(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: URL_ });
  await c.connect();
  clients.push(c);
  return c;
}

/** A closed request whose audit is long past due. */
async function oldRequest(tag: string): Promise<string> {
  const [r] = await q(
    `INSERT INTO account_deletion_request (user_id, email_hash, kind, org_context, status, closed_at)
     VALUES ($1, 'h', 'DEPARTURE', '{"type":"INDIVIDUAL"}', 'COMPLETED', now() - interval '500 days') RETURNING id`,
    [`u-${tag}`],
  );
  await q(`INSERT INTO account_deletion_event (request_id, type, actor_type) VALUES ($1, 'TRANSITION', 'SYSTEM')`, [r!.id]);
  return r!.id as string;
}

/** Resolves once some backend on this database is waiting for a lock. */
async function untilSomeoneWaitsOnALock(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [r] = await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (Number(r!.n) > 0) return;
    if (Date.now() > deadline) throw new Error("nobody started waiting on a lock within 10 s");
    await new Promise((res) => setTimeout(res, 20));
  }
}

async function sweep(hooks?: import("./retention.ts").SweepHooks) {
  const now = LATER();
  const due = (await ret.previewRetention({ now, env: {} })).items.filter((i) => i.due).length;
  return ret.executeRetentionSweep({ actor: dev(), confirmCount: due, now, env: {}, hooks });
}

const request = async (id: string) => (await q(`SELECT audit_expired_at, legal_hold_at FROM account_deletion_request WHERE id = $1`, [id]))[0]!;
const events = async (id: string) => Number((await q(`SELECT count(*)::int AS n FROM account_deletion_event WHERE request_id = $1`, [id]))[0]!.n);

t("1. sweep locks first: a concurrent hold waits, the expiry completes, then the hold is accepted", async () => {
  const id = await oldRequest("lock-first");
  let hold: Promise<unknown> | null = null;
  const res = await sweep({
    async afterLock(it) {
      if (it.id !== id) return;
      hold = svc.setLegalHold({ id, actor: dev(), reason: "arrives mid-sweep" });
      await untilSomeoneWaitsOnALock(); // the hold is blocked on our row lock
    },
  });
  assert.ok(res.done.some((i) => i.id === id), "expired");
  await hold; // accepted once the sweep's transaction committed
  const r = await request(id);
  assert.ok(r.audit_expired_at, "the audit expired");
  assert.ok(r.legal_hold_at, "and the hold was then accepted on the skeleton");
});

t("2. a hold committed before the sweep locks: the sweep refuses the item", async () => {
  const id = await oldRequest("hold-first");
  const res = await sweep({
    async beforeLock(it) {
      if (it.id === id) await svc.setLegalHold({ id, actor: dev(), reason: "committed between preview and lock" });
    },
  });
  assert.ok(res.unchanged.some((i) => i.id === id), "not expired: no longer eligible");
  assert.ok(!res.done.some((i) => i.id === id));
  assert.equal((await request(id)).audit_expired_at, null);
  assert.ok((await events(id)) >= 1, "its audit events are intact");
});

t("3. a hold in flight on the row when the sweep locks: the sweep waits, the hold commits, the sweep refuses", async () => {
  const id = await oldRequest("hold-in-flight");
  const other = await connect();
  await other.query("BEGIN");
  await other.query(`UPDATE account_deletion_request SET legal_hold_at = now(), legal_hold_reason = 'in flight', legal_hold_by = 'dev' WHERE id = $1`, [id]);

  const running = sweep();
  await untilSomeoneWaitsOnALock(); // the sweep is blocked on the hold's row lock
  await other.query("COMMIT");
  const res = await running;
  assert.ok(res.unchanged.some((i) => i.id === id), JSON.stringify(res));
  assert.equal((await request(id)).audit_expired_at, null);
  assert.ok((await events(id)) >= 1);
});

t("4. the same for a suppression marker: a hold in flight keeps the marker", async () => {
  const id = await oldRequest("marker-hold");
  // Its audit is already expired; only the marker is due.
  await q(`UPDATE account_deletion_request SET audit_expired_at = now() WHERE id = $1`, [id]);
  const [m] = await q(`INSERT INTO deletion_suppression (request_id, email_hash, expires_at, created_at) VALUES ($1, 'h', now() - interval '1 day', now() - interval '400 days') RETURNING id`, [id]);
  const other = await connect();
  await other.query("BEGIN");
  await other.query(`UPDATE account_deletion_request SET legal_hold_at = now(), legal_hold_reason = 'in flight', legal_hold_by = 'dev' WHERE id = $1`, [id]);

  const running = sweep();
  await untilSomeoneWaitsOnALock();
  await other.query("COMMIT");
  const res = await running;
  assert.ok(res.unchanged.some((i) => i.id === m!.id), JSON.stringify(res));
  assert.equal(Number((await q(`SELECT count(*)::int AS n FROM deletion_suppression WHERE id = $1`, [m!.id]))[0]!.n), 1, "marker kept");
});

t("5. a held request that is not yet due is untouched", async () => {
  // Held and recent: neither rule lets it through.
  const [r] = await q(
    `INSERT INTO account_deletion_request (user_id, email_hash, kind, org_context, status, closed_at, legal_hold_at, legal_hold_reason, legal_hold_by)
     VALUES ('u-recent', 'h', 'DEPARTURE', '{"type":"INDIVIDUAL"}', 'COMPLETED', now(), now(), 'x', 'dev') RETURNING id`,
  );
  await sweep();
  assert.equal((await request(r!.id as string)).audit_expired_at, null);
});
