/**
 * The account-deletion service end to end, against a real Postgres.
 *
 * PGlite (Postgres in WASM, in this process) is served over a local socket so
 * the app's own `pg` pool, drizzle queries, transactions and the fence trigger
 * all run unmodified. Every migration is applied first. Object storage and the
 * ledger are in-memory fakes with failure injection; no Google call is made
 * because the seeded users have no Google connection.
 *
 * SAFETY: DATABASE_URL is set to the local socket BEFORE the app modules are
 * imported, and the first test asserts the pool really points there. Nothing
 * here can reach the development or production database.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { deletionDisplayState } from "./policy.ts";
import type { DeletionObjectStore } from "./storage.ts";
import { freePort } from "./testing/free-port.ts";
import { LEDGER_DEFERRAL, resolveLedger, type DeletionLedger, type LedgerEntry } from "./ledger.ts";

const PORT = await freePort();
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

let pg: PGlite;
let server: PGLiteSocketServer;
let svc: typeof import("./service.ts");
let dbmod: typeof import("@repo/database");

// ── Fakes ─────────────────────────────────────────────────────────────

const objects = new Set<string>();
let failDeletes = false;
const store: DeletionObjectStore = {
  keyPrefix: "test",
  async listObjects(prefix) {
    return { keys: [...objects].filter((k) => k.startsWith(prefix)) };
  },
  async listUploads() {
    return { uploads: [] };
  },
  async deleteObject(key) {
    if (failDeletes) throw Object.assign(new Error("simulated outage"), { name: "ServiceUnavailable" });
    objects.delete(key);
  },
  async abortUpload() {},
};

// A ledger that IS configured but failing — the FAILED path. The owner's
// deferral (no ledger configured at all) is the last test, via resolveLedger({}).
const ledgerWrites: LedgerEntry[] = [];
let ledgerConfigured = false;
const ledger: DeletionLedger = {
  async write(e) {
    if (!ledgerConfigured) throw new Error("simulated ledger outage");
    ledgerWrites.push(e);
  },
  async list() {
    return ledgerWrites;
  },
};

let clock = new Date("2026-10-28T10:00:00Z");
const deps = { now: () => clock, store: () => store, ledger: () => ledger };

const dev = () => ({ type: "DEVELOPER" as const, userId: "dev-1", email: "dev@mailroid.test" });

// ── Setup ─────────────────────────────────────────────────────────────

before(async () => {
  pg = await PGlite.create({ extensions: { vector } });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const dir = fileURLToPath(new URL("../../database/drizzle/", import.meta.url));
  const journal = JSON.parse(readFileSync(`${dir}meta/_journal.json`, "utf8")) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    for (const stmt of readFileSync(`${dir}${tag}.sql`, "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  await pg.exec(`
    INSERT INTO "user" (id, name, email, platform_role) VALUES
      ('dev-1', 'Dev', 'dev@mailroid.test', 'DEVELOPER'),
      ('u-solo', 'Solo', 'solo@x.test', 'USER'),
      ('u-other', 'Other', 'other@x.test', 'USER'),
      ('u-org', 'Org Member', 'member@acme.test', 'USER'),
      ('u-flaky', 'Flaky', 'flaky@x.test', 'USER'),
      ('u-cancel', 'Cancel', 'cancel@x.test', 'USER'),
      ('u-race', 'Race', 'race@x.test', 'USER');
    INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES
      ('s1', 't1', 'u-solo', now() + interval '1 day', now()),
      ('s2', 't2', 'u-other', now() + interval '1 day', now());
    INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES
      ('m1', 't1', 'u-solo'), ('m2', 't2', 'u-solo'), ('m3', 't3', 'u-other'), ('m4', 't4', 'u-flaky');
    INSERT INTO organization (id, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Acme');
    INSERT INTO org_membership (organization_id, email, role) VALUES
      ('00000000-0000-0000-0000-0000000000a1', 'boss@acme.test', 'OWNER'),
      ('00000000-0000-0000-0000-0000000000a1', 'member@acme.test', 'MEMBER');
  `);
  objects.add("test/attachments/u-solo/a1");
  objects.add("test/attachments/u-solo/a2");
  objects.add("test/attachments/u-other/b1");
  objects.add("test/attachments/u-flaky/c1");

  server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
  await server.start();

  process.env.DATABASE_URL = URL_;
  process.env.CORSAIR_KEK ??= Buffer.alloc(32, 1).toString("base64");
  // Set, not deleted: importing @repo/database loads .env, which would refill an unset variable.
  process.env.DELETION_ENABLED = "false";
  process.env.DELETION_TEST_ALLOWLIST = "";

  dbmod = await import("@repo/database");
  svc = await import("./service.ts");
});

after(async () => {
  await dbmod?.pool.end().catch(() => undefined);
  await server?.stop().catch(() => undefined);
  await pg?.close().catch(() => undefined);
});

const q = async (text: string, params: unknown[] = []) => (await dbmod.pool.query(text, params)).rows;
const count = async (table: string, col: string, id: string) => Number((await q(`SELECT count(*)::int AS n FROM "${table}" WHERE ${col} = $1`, [id]))[0]!.n);

// ── Tests ─────────────────────────────────────────────────────────────

test("the pool points at the in-process database, nothing else", async () => {
  const opts = (dbmod.pool as unknown as { options: { connectionString: string } }).options;
  assert.equal(opts.connectionString, URL_);
  const r = await q("SELECT count(*)::int AS n FROM \"user\"");
  assert.equal(r[0]!.n, 7);
});

test("the fence trigger is installed everywhere the inventory requires", async () => {
  const s = await svc.fenceTriggerStatus();
  assert.deepEqual(s, { installed: true, missing: [] });
});

let soloId = "";

test("a user submits; the request is recorded as an individual with an audit row", async () => {
  assert.equal(process.env.DELETION_ENABLED, "false", "submitting must work with deletion off");
  const r = await svc.submitDeletionRequest({ userId: "u-solo", kind: "DEPARTURE", reason: "leaving the company" });
  soloId = r.id;
  assert.equal(r.status, "SUBMITTED");
  // Submitting is asking, nothing more: no fence, no step run, sessions and data intact.
  assert.equal(await svc.isTenantFenced("u-solo"), false);
  assert.deepEqual(r.steps, {});
  assert.equal(r.fencedAt, null);
  assert.equal(await count("session", "user_id", "u-solo"), 1);
  assert.equal(await count("emails", "user_id", "u-solo"), 2);
  assert.equal(await count("sync_pauses", "tenant_id", "u-solo"), 0);
  assert.deepEqual(r.orgContext, { type: "INDIVIDUAL" });
  const events = await svc.listDeletionEvents(r.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actorType, "USER");
  await assert.rejects(svc.submitDeletionRequest({ userId: "u-solo", kind: "DEPARTURE", reason: "again" }), /ALREADY_OPEN|already/);
});

test("an org member can't be fenced without --org-confirmed", async () => {
  const r = await svc.submitDeletionRequest({ userId: "u-org", kind: "DEPARTURE", reason: "moving on" });
  assert.equal(r.orgContext.type, "ORG_MEMBER");
  await assert.rejects(
    svc.fenceAccount({ id: r.id, actor: dev(), confirmEmail: "member@acme.test", orgConfirmed: false, lastOwnerChoices: {} }, deps),
    (e: Error & { code?: string }) => e.code === "ORG_NOT_CONFIRMED",
  );
  assert.equal((await svc.getDeletionRequest(r.id))!.status, "SUBMITTED", "nothing changed");
  assert.equal(await svc.isTenantFenced("u-org"), false);
});

test("a mistyped confirmation email changes nothing", async () => {
  await assert.rejects(
    svc.fenceAccount({ id: soloId, actor: dev(), confirmEmail: "solo@x.tes", orgConfirmed: false, lastOwnerChoices: {} }, deps),
    (e: Error & { code?: string }) => e.code === "CONFIRMATION_MISMATCH",
  );
  assert.equal(await svc.isTenantFenced("u-solo"), false);
});

test("fence: writes blocked, sessions revoked, sync paused, each step recorded honestly", async () => {
  const res = await svc.fenceAccount({ id: soloId, actor: dev(), confirmEmail: "SOLO@x.test", orgConfirmed: false, lastOwnerChoices: {} }, deps);
  const r = res.request;
  assert.equal(r.status, "FENCED");
  assert.equal(r.steps.writeLedger!.status, "FAILED", "a failing ledger is FAILED, never DONE or deferred");
  assert.match(r.steps.writeLedger!.error!, /simulated ledger outage/);
  assert.equal(r.steps.revokeSessions!.status, "DONE");
  assert.equal(r.steps.stopGmailWatch!.status, "SKIPPED");
  assert.equal(r.steps.pauseSync!.status, "DONE");
  assert.ok(r.fencedConfirmedAt, "confirming steps succeeded");
  assert.equal(r.deleteEligibleAt!.toISOString(), "2026-10-28T22:00:00.000Z");

  assert.equal(await svc.isTenantFenced("u-solo"), true);
  assert.equal(await count("session", "user_id", "u-solo"), 0);
  assert.equal(await count("session", "user_id", "u-other"), 1, "other users keep their sessions");
  assert.equal(await count("sync_pauses", "tenant_id", "u-solo"), 1);

  await assert.rejects(q(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('late', 't', 'u-solo')`), /TENANT_FENCED/);
  await assert.rejects(q(`INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES ('s9', 't9', 'u-solo', now(), now())`), /TENANT_FENCED/);
  await q(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('fine', 't', 'u-other')`);
});

test("a second fence of the same request is refused", async () => {
  await assert.rejects(
    svc.fenceAccount({ id: soloId, actor: dev(), confirmEmail: "solo@x.test", orgConfirmed: false, lastOwnerChoices: {} }, deps),
    (e: Error & { code?: string }) => e.code === "WRONG_STATUS",
  );
});

test("delete one minute before the 12 h mark is refused, and the refusal is audited", async () => {
  clock = new Date("2026-10-28T21:59:00Z");
  await assert.rejects(
    svc.deleteAccount({ id: soloId, actor: dev(), confirmEmail: "solo@x.test" }, deps),
    (e: Error & { code?: string }) => e.code === "TOO_EARLY",
  );
  const events = await svc.listDeletionEvents(soloId);
  assert.ok(events.some((e) => e.type === "DELETE_REFUSED" && (e.detail as { code?: string })?.code === "TOO_EARLY"));
});

test("at 12 h, deletion is still off unless enabled or allowlisted", async () => {
  clock = new Date("2026-10-28T22:00:00Z");
  await assert.rejects(
    svc.deleteAccount({ id: soloId, actor: dev(), confirmEmail: "solo@x.test" }, deps),
    (e: Error & { code?: string }) => e.code === "DELETION_DISABLED",
  );
  process.env.DELETION_TEST_ALLOWLIST = "solo@x.test,flaky@x.test";
});

test("an unresolved ledger step blocks deletion until accepted with a reason", async () => {
  await assert.rejects(
    svc.deleteAccount({ id: soloId, actor: dev(), confirmEmail: "solo@x.test" }, deps),
    (e: Error & { code?: string }) => e.code === "STEPS_UNRESOLVED",
  );
  await assert.rejects(
    svc.deleteAccount({ id: soloId, actor: dev(), confirmEmail: "solo@x.test", acceptUnresolved: ["writeLedger"] }, deps),
    (e: Error & { code?: string }) => e.code === "REASON_REQUIRED",
  );
});

test("delete purges database and storage for this user only, verifies, and minimises", async () => {
  const res = await svc.deleteAccount(
    { id: soloId, actor: dev(), confirmEmail: "solo@x.test", acceptUnresolved: ["writeLedger"], acceptReason: "ledger location pending" },
    deps,
  );
  assert.equal(res.request.status, "COMPLETED", res.request.lastError ?? "");
  assert.equal(res.report.verification.verified, true);
  assert.deepEqual(res.report.verification.dbRemaining, {});

  assert.equal(await count("user", "id", "u-solo"), 0);
  assert.equal(await count("emails", "user_id", "u-solo"), 0);
  assert.equal(await count("emails", "user_id", "u-other"), 2, "other user's mail untouched");
  assert.deepEqual([...objects].filter((k) => k.includes("/u-solo/")), []);
  assert.ok(objects.has("test/attachments/u-other/b1"));

  const r = res.request;
  assert.equal(r.email, null, "email minimised");
  assert.equal(r.details, null);
  assert.ok(r.emailHash);
  assert.equal(r.storageBlockMode, "LIFECYCLE_ONLY");
  assert.deepEqual(r.acceptedUnresolved, { steps: ["writeLedger"], reason: "ledger location pending" });
  assert.match(deletionDisplayState({ ...r, now: clock }).label, /late writes not blocked/);

  // The fence row stays FENCED forever.
  assert.equal(await svc.isTenantFenced("u-solo"), true);

  // Every transition is in the audit trail, in order.
  const moves = (await svc.listDeletionEvents(soloId)).filter((e) => e.type === "TRANSITION").map((e) => e.toStatus);
  assert.deepEqual(moves, ["FENCED", "PURGING", "VERIFYING", "COMPLETED"]);
  const userEvents = (await svc.listDeletionEvents(soloId)).filter((e) => e.actorType === "USER");
  assert.ok(userEvents.every((e) => e.actorEmail === r.emailHash), "user's address scrubbed from the audit trail");
});

test("a storage failure ends PURGE_FAILED with the error — and retry finishes it", async () => {
  const sub = await svc.submitDeletionRequest({ userId: "u-flaky", kind: "PRIVACY_ERASURE", reason: "erase me" });
  clock = new Date("2026-10-29T00:00:00Z");
  const f = await svc.fenceAccount({ id: sub.id, actor: dev(), confirmEmail: "flaky@x.test", orgConfirmed: false, lastOwnerChoices: {} }, deps);
  assert.ok(f.request.fencedConfirmedAt);
  clock = new Date("2026-10-29T12:00:00Z");

  failDeletes = true;
  const bad = await svc.deleteAccount(
    { id: sub.id, actor: dev(), confirmEmail: "flaky@x.test", acceptUnresolved: ["writeLedger"], acceptReason: "pending" },
    deps,
  );
  assert.equal(bad.request.status, "PURGE_FAILED");
  assert.match(bad.request.lastError!, /storage purge incomplete.*simulated outage/s);
  assert.equal(await count("emails", "user_id", "u-flaky"), 1, "database untouched when storage failed first");

  failDeletes = false;
  const good = await svc.retryDeletion({ id: sub.id, actor: dev(), confirmEmail: "flaky@x.test" }, deps);
  assert.equal(good.request.status, "COMPLETED", good.request.lastError ?? "");
  assert.equal(await count("emails", "user_id", "u-flaky"), 0);
});

test("cancel before deletion unfences, lifts the pause, and says what it can't undo", async () => {
  const sub = await svc.submitDeletionRequest({ userId: "u-cancel", kind: "DEPARTURE", reason: "changed mind later" });
  await svc.fenceAccount({ id: sub.id, actor: dev(), confirmEmail: "cancel@x.test", orgConfirmed: false, lastOwnerChoices: {} }, deps);
  assert.equal(await svc.isTenantFenced("u-cancel"), true);
  const c = await svc.cancelFence({ id: sub.id, actor: dev(), reason: "user withdrew by email" });
  assert.equal(c.request.status, "CANCELLED");
  assert.equal(await svc.isTenantFenced("u-cancel"), false);
  assert.equal(await count("sync_pauses", "tenant_id", "u-cancel"), 0);
  assert.ok(c.recoveryNeeded.some((n) => /sign in again/.test(n)));
  await q(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('back', 't', 'u-cancel')`);
  // Ever-fenced is never cleared.
  assert.equal((await q(`SELECT ever_fenced FROM tenant_epoch WHERE tenant_id = 'u-cancel'`))[0]!.ever_fenced, true);
});

test("concurrent fences of one request: exactly one wins", async () => {
  const sub = await svc.submitDeletionRequest({ userId: "u-race", kind: "DEPARTURE", reason: "race test" });
  const go = () => svc.fenceAccount({ id: sub.id, actor: dev(), confirmEmail: "race@x.test", orgConfirmed: false, lastOwnerChoices: {} }, deps);
  const results = await Promise.allSettled([go(), go(), go()]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(won.length, 1);
  for (const l of lost) assert.ok(["CONFLICT", "WRONG_STATUS"].includes((l.reason as { code?: string }).code ?? ""), String(l.reason));
  const fencedMoves = (await svc.listDeletionEvents(sub.id)).filter((e) => e.type === "TRANSITION" && e.toStatus === "FENCED");
  assert.equal(fencedMoves.length, 1);
});

test("withdraw is only possible while SUBMITTED", async () => {
  await assert.rejects(svc.withdrawDeletionRequest("u-race"), (e: Error & { code?: string }) => e.code === "NOT_WITHDRAWABLE");
  const w = await svc.withdrawDeletionRequest("u-org");
  assert.equal(w.status, "WITHDRAWN");
});

// ═════ Ledger deferred by owner decision ═════════════════════════════

test("ledger deferred: no ledger configured → DEFERRED_BY_OWNER, never DONE; deletion needs no --accept-unresolved", async () => {
  await q(`INSERT INTO "user" (id, name, email, platform_role) VALUES ('u-deferred', 'Deferred', 'deferred@x.test', 'USER')`);
  // The production wiring with nothing set: resolveLedger reads an env with no prefix.
  const deferredDeps = { ...deps, ledger: () => resolveLedger({}) };
  const sub = await svc.submitDeletionRequest({ userId: "u-deferred", kind: "DEPARTURE", reason: "ledger deferral" });
  clock = new Date("2026-10-30T00:00:00Z");
  const f = await svc.fenceAccount({ id: sub.id, actor: dev(), confirmEmail: "deferred@x.test", orgConfirmed: false, lastOwnerChoices: {} }, deferredDeps);
  const step = f.request.steps.writeLedger!;
  assert.equal(step.status, "DEFERRED_BY_OWNER");
  assert.equal(step.error, null);
  assert.equal(step.detail?.limitation, LEDGER_DEFERRAL.limitation, "the limitation is recorded on the step");
  const evs = await svc.listDeletionEvents(sub.id);
  assert.ok(evs.some((e) => e.type === "STEP_DEFERRED_BY_OWNER"));
  assert.ok(!evs.some((e) => e.type === "STEP_DONE" && (e.detail as { step?: string })?.step === "writeLedger"), "never recorded as written");

  clock = new Date("2026-10-30T12:00:00Z");
  process.env.DELETION_TEST_ALLOWLIST = "deferred@x.test";
  const res = await svc.deleteAccount({ id: sub.id, actor: dev(), confirmEmail: "deferred@x.test" }, deferredDeps);
  assert.equal(res.request.status, "COMPLETED", res.request.lastError ?? "");
  assert.equal(res.request.acceptedUnresolved, null, "nothing was accepted unresolved");
  assert.ok(res.report.outside.some((l) => l.includes(LEDGER_DEFERRAL.limitation)), "the report states the restore limitation");
  assert.ok(!res.report.outside.some((l) => /ledger records this deletion/.test(l)), "and never claims the protection");
  const after = (await svc.listDeletionEvents(sub.id)).map((e) => e.type);
  assert.ok(after.includes("LEDGER_DEFERRED"));
  assert.ok(!after.includes("LEDGER_COMPLETED") && !after.includes("LEDGER_WRITE_FAILED"));
});

test("ledger deferral covers only an unset ledger: a set-but-wrong prefix still FAILS", async () => {
  await q(`INSERT INTO "user" (id, name, email, platform_role) VALUES ('u-badledger', 'Bad', 'badledger@x.test', 'USER')`);
  const badDeps = { ...deps, ledger: () => resolveLedger({ DELETION_LEDGER_PREFIX: "prod/attachments" }) };
  const sub = await svc.submitDeletionRequest({ userId: "u-badledger", kind: "DEPARTURE", reason: "bad ledger" });
  const f = await svc.fenceAccount({ id: sub.id, actor: dev(), confirmEmail: "badledger@x.test", orgConfirmed: false, lastOwnerChoices: {} }, badDeps);
  assert.equal(f.request.steps.writeLedger!.status, "FAILED");
  assert.match(f.request.steps.writeLedger!.error!, /attachments/);
});
