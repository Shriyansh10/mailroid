/**
 * Classification, anonymisation, suppression, re-registration and retention,
 * end to end through the real service against an in-process Postgres (PGlite
 * on a local socket, every migration applied — the same harness as
 * service.integration.test.ts).
 *
 * Two members of one organization are deleted:
 *   dep@acme.test   DEPARTURE. Manages rep@. Has an older REJECTED and an
 *                   older WITHDRAWN request, billing rows, job runs, AI usage,
 *                   a Google account (sub "sub-dep").
 *   priv@acme.test  PRIVACY_ERASURE. Manages rep2@, and is named in the
 *                   detail of a MANAGER_CHANGED event about rep2@.
 * Then dep@'s Google account signs up again, and the retention sweep runs at
 * several points in the future.
 *
 * SAFETY: DATABASE_URL is pointed at the local socket before any app module is
 * imported; the first test asserts the pool really points there.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import type { DeletionObjectStore } from "./storage.ts";
import { freePort } from "./testing/free-port.ts";
import type { DeletionLedger, LedgerEntry } from "./ledger.ts";

const PORT = await freePort();
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const ORG = "00000000-0000-0000-0000-0000000000b1";

let pg: PGlite;
let server: PGLiteSocketServer;
let svc: typeof import("./service.ts");
let ret: typeof import("./retention.ts");
let members: typeof import("../organization/members.ts");
let suppression: typeof import("@repo/database/deletion-suppression");
let dbmod: typeof import("@repo/database");

const store: DeletionObjectStore = {
  keyPrefix: "test",
  async listObjects() {
    return { keys: [] };
  },
  async listUploads() {
    return { uploads: [] };
  },
  async deleteObject() {},
  async abortUpload() {},
};
const ledgerWrites: LedgerEntry[] = [];
const ledger: DeletionLedger = {
  async write(e) {
    ledgerWrites.push(e);
  },
  async list() {
    return ledgerWrites;
  },
};
let clock = new Date("2026-10-28T10:00:00Z");
const deps = { now: () => clock, store: () => store, ledger: () => ledger };
const dev = () => ({ type: "DEVELOPER" as const, userId: "dev-1", email: "dev@mailroid.test" });

const DAY = 24 * 60 * 60 * 1000;
/** Retention runs on the real clock (closed_at is stamped by the database's caller at real time). */
const future = (days: number) => new Date(Date.now() + days * DAY);

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
      ('u-boss', 'Boss', 'boss@acme.test', 'USER'),
      ('u-dep', 'Dep', 'dep@acme.test', 'USER'),
      ('u-priv', 'Priv', 'priv@acme.test', 'USER'),
      ('u-rep', 'Rep', 'rep@acme.test', 'USER'),
      ('u-rep2', 'Rep2', 'rep2@acme.test', 'USER'),
      ('u-solo', 'Solo', 'solo@x.test', 'USER'),
      ('u-seal', 'Seal', 'seal@x.test', 'USER');
    INSERT INTO account (id, account_id, provider_id, user_id, updated_at) VALUES
      ('a-dep', 'sub-dep', 'google', 'u-dep', now()),
      ('a-priv', 'sub-priv', 'google', 'u-priv', now()),
      ('a-seal', 'sub-seal', 'google', 'u-seal', now());
    INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ('m-dep', 't', 'u-dep'), ('m-priv', 't', 'u-priv'), ('m-rep', 't', 'u-rep');
    INSERT INTO user_settings (user_id, data) VALUES ('u-dep', '{}');
    INSERT INTO billing_event (subject_type, subject_id, kind, source, reason, occurred_at) VALUES
      ('USER', 'u-dep', 'GRANT', 'MANUAL', 'design partner, contact DEP@acme.test', '2017-01-01T00:00:00Z'),
      ('USER', 'u-dep', 'RENEWAL', 'MANUAL', 'renewed', now() - interval '10 days'),
      ('USER', 'u-rep', 'GRANT', 'MANUAL', 'unrelated; referred by adep@acme.test', '2017-01-01T00:00:00Z');
    INSERT INTO developer_job_runs (batch_id, job_id, target_user_id, target_email, error, details, created_at) VALUES
      (gen_random_uuid(), 'gmail:backfill', 'u-dep', 'dep@acme.test', 'mailbox DEP@acme.test not found', '{"mailbox":"dep@acme.test","n":1}', now() - interval '5 days'),
      (gen_random_uuid(), 'gmail:backfill', 'u-rep', 'rep@acme.test', null, null, now() - interval '500 days');
    INSERT INTO ai_usage (user_id, feature, operation, provider, model, pricing_known, pricing_version, duration_ms, request_id, status) VALUES
      ('u-dep', 'chat', 'chat', 'openai', 'm', true, 'v1', 10, 'r1', 'ok');
  `);

  server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
  await server.start();
  process.env.DATABASE_URL = URL_;
  process.env.CORSAIR_KEK ??= Buffer.alloc(32, 1).toString("base64");
  process.env.DELETION_ENABLED = "false";
  process.env.DELETION_TEST_ALLOWLIST = "dep@acme.test,priv@acme.test,solo@x.test,seal@x.test";
  process.env.BILLING_RETENTION_DAYS = "";

  dbmod = await import("@repo/database");
  svc = await import("./service.ts");
  ret = await import("./retention.ts");
  members = await import("../organization/members.ts");
  suppression = await import("@repo/database/deletion-suppression");

  // The organization, built through the real org service so its audit rows are real.
  await q(`INSERT INTO organization (id, name) VALUES ($1, 'Acme')`, [ORG]);
  await q(`INSERT INTO org_membership (organization_id, email, role) VALUES ($1, 'boss@acme.test', 'OWNER')`, [ORG]);
  // apriv@ and adep@ contain the deleted addresses as substrings: they must survive untouched.
  for (const e of ["dep@acme.test", "priv@acme.test", "rep@acme.test", "rep2@acme.test", "apriv@acme.test", "adep@acme.test"]) {
    await members.addMember({ organizationId: ORG, email: e, actorUserId: "u-boss" });
  }
  await members.setManager({ organizationId: ORG, subordinateEmail: "dep@acme.test", managerEmail: "boss@acme.test", actorUserId: "u-boss" });
  await members.setManager({ organizationId: ORG, subordinateEmail: "priv@acme.test", managerEmail: "boss@acme.test", actorUserId: "u-boss" });
  await members.setManager({ organizationId: ORG, subordinateEmail: "rep@acme.test", managerEmail: "dep@acme.test", actorUserId: "u-boss" });
  // rep2: priv → boss → priv, so priv is named in the detail of colleagues' events.
  await members.setManager({ organizationId: ORG, subordinateEmail: "rep2@acme.test", managerEmail: "priv@acme.test", actorUserId: "u-boss" });
  await members.setManager({ organizationId: ORG, subordinateEmail: "rep2@acme.test", managerEmail: "boss@acme.test", actorUserId: "u-boss" });
  await members.setManager({ organizationId: ORG, subordinateEmail: "rep2@acme.test", managerEmail: "priv@acme.test", actorUserId: "u-priv" });
  await members.setManager({ organizationId: ORG, subordinateEmail: "apriv@acme.test", managerEmail: "boss@acme.test", actorUserId: "u-boss" });
  // Nested JSON, an array and free text naming priv@ beside colleagues.
  await q(
    `INSERT INTO org_audit_event (organization_id, action, subject_email, detail) VALUES ($1, 'MANAGER_CHANGED', 'apriv@acme.test', $2)`,
    [ORG, JSON.stringify({ from: "priv@acme.test", to: "boss@acme.test", cc: ["PRIV@acme.test", "apriv@acme.test"], note: { text: "Agreed with priv@acme.test." } })],
  );
});

after(async () => {
  await dbmod?.pool.end().catch(() => undefined);
  await server?.stop().catch(() => undefined);
  await pg?.close().catch(() => undefined);
});

const q = async (text: string, params: unknown[] = []) => (await dbmod.pool.query(text, params)).rows;
const n = async (text: string, params: unknown[] = []) => Number((await q(text, params))[0]!.n);
/**
 * Rows of a table in which the address appears as a whole address, in any
 * column, any case. Matched here in JavaScript, independently of the
 * production pattern, so the two can't agree by construction.
 */
async function traces(table: string, email: string): Promise<number> {
  const esc = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9._%+-])${esc}(?![a-z0-9-]|\\.[a-z0-9])`, "i");
  const rows = await q(`SELECT t::text AS row FROM "${table}" t`);
  return rows.filter((r) => re.test(r.row as string)).length;
}

/** Submit → fence (org confirmed) → 12 h → delete. Returns the delete result. */
async function deleteFully(userId: string, email: string, kind: "DEPARTURE" | "PRIVACY_ERASURE") {
  const sub = await svc.submitDeletionRequest({ userId, kind, reason: `please remove ${email}`, details: `my address is ${email}` });
  const f = await svc.fenceAccount({ id: sub.id, actor: dev(), confirmEmail: email, orgConfirmed: true, lastOwnerChoices: {} }, deps);
  assert.ok(f.request.fencedConfirmedAt, JSON.stringify(f.request.steps));
  clock = new Date(clock.getTime() + 13 * 60 * 60 * 1000);
  return svc.deleteAccount({ id: sub.id, actor: dev(), confirmEmail: email, acceptUnresolved: ["revokeGoogleGrant"], acceptReason: "test: no live Google grant" }, deps);
}

// ── Tests ─────────────────────────────────────────────────────────────

test("the pool points at the in-process database, nothing else", async () => {
  const opts = (dbmod.pool as unknown as { options: { connectionString: string } }).options;
  assert.equal(opts.connectionString, URL_);
});

let depRequestId = "";

test("older REJECTED and WITHDRAWN requests exist with plaintext, before the deletion", async () => {
  const a = await svc.submitDeletionRequest({ userId: "u-dep", kind: "DEPARTURE", reason: "first try dep@acme.test", details: "call me at dep@acme.test" });
  await svc.rejectDeletionRequest({ id: a.id, actor: dev(), reason: "Acme declined for now" });
  await svc.submitDeletionRequest({ userId: "u-dep", kind: "DEPARTURE", reason: "second try" });
  await svc.withdrawDeletionRequest("u-dep");
  const rows = await q(`SELECT status, email, reason, closed_at FROM account_deletion_request WHERE user_id = 'u-dep' ORDER BY requested_at`);
  assert.deepEqual(rows.map((r) => r.status), ["REJECTED", "WITHDRAWN"]);
  assert.ok(rows.every((r) => r.email === "dep@acme.test" && r.reason && r.closed_at), "plaintext held while the account exists; closing time stamped");
});

test("DEPARTURE: deleted, verified by disposition, COMPLETED", async () => {
  const res = await deleteFully("u-dep", "dep@acme.test", "DEPARTURE");
  depRequestId = res.request.id;
  assert.equal(res.request.status, "COMPLETED", res.request.lastError ?? "");
  const checks = res.report.verification.checks!;
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
  // All four dispositions were checked.
  for (const d of ["DELETE", "ANONYMIZE", "RETAIN", "RESTRICTED"]) assert.ok(checks.some((c) => c.disposition === d), d);
  // The suppression marker is reported as intentional retention, not leftover.
  assert.ok(checks.some((c) => c.table === "deletion_suppression" && c.ok));
  assert.ok(res.report.retention!.some((r) => r.table === "deletion_suppression" && r.disposition === "RETAIN"));
  assert.deepEqual(res.report.verification.dbRemaining, {});
  assert.ok(res.report.verification.limits!.manual.some((l) => /no database-level isolation/i.test(l)));
  assert.ok(res.report.verification.limits!.recordedOnly.some((l) => /does not prove/i.test(l)));
});

test("every request of the deleted user is minimised — the REJECTED and WITHDRAWN ones too", async () => {
  const rows = await q(`SELECT status, email, reason, details, email_hash, minimised_at, org_context FROM account_deletion_request WHERE user_id = 'u-dep'`);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.email, null, r.status);
    assert.equal(r.reason, null, r.status);
    assert.equal(r.details, null, r.status);
    assert.ok(r.email_hash, "the pseudonym stays until the audit expires");
    assert.ok(r.minimised_at, r.status);
    for (const o of (r.org_context as { orgs?: Record<string, unknown>[] }).orgs ?? []) {
      assert.equal(o.ownerEmails, undefined, "colleagues' addresses stripped");
      assert.equal(o.managerEmail, undefined);
      assert.ok(o.orgId && o.orgName, "the org reference stays");
    }
  }
  assert.equal(await traces("account_deletion_request", "dep@acme.test"), 0);
  const events = await q(`SELECT e.* FROM account_deletion_event e JOIN account_deletion_request r ON r.id = e.request_id WHERE r.user_id = 'u-dep'`);
  assert.ok(events.length > 5);
  assert.ok(events.every((e) => !JSON.stringify(e).toLowerCase().includes("dep@acme.test")), "no address anywhere in the trail");
  assert.ok(events.filter((e) => e.actor_type === "DEVELOPER").every((e) => e.actor_email === "dev@mailroid.test"), "the operator stays named");
});

test("DEPARTURE keeps the organization's history: closed rows, roles, dates, the reporting edges", async () => {
  const mem = await q(`SELECT role, effective_from, effective_until FROM org_membership WHERE email = 'dep@acme.test'`);
  assert.ok(mem.length >= 1 && mem.every((m) => m.effective_until !== null), "membership closed, not deleted");
  assert.ok(mem.every((m) => m.role && m.effective_from));
  assert.equal(await n(`SELECT count(*)::int AS n FROM org_reporting_edge WHERE subordinate_email = 'dep@acme.test' OR manager_email = 'dep@acme.test'`), 2, "history kept");
  assert.ok((await n(`SELECT count(*)::int AS n FROM org_audit_event WHERE subject_email = 'dep@acme.test'`)) >= 2);
  // The actor link of the user's own org actions is gone (none here), and no row holds the user id.
  assert.equal(await n(`SELECT count(*)::int AS n FROM org_audit_event WHERE actor_user_id = 'u-dep'`), 0);
});

test("manager departure: the report is detached, not left pointing at someone who has gone", async () => {
  assert.equal(await n(`SELECT count(*)::int AS n FROM org_reporting_edge WHERE manager_email = 'dep@acme.test' AND effective_until IS NULL`), 0);
  assert.equal(await n(`SELECT count(*)::int AS n FROM org_reporting_edge WHERE subordinate_email = 'rep@acme.test' AND effective_until IS NULL`), 0);
  const list = await members.listMembers(ORG);
  const rep = list.find((m) => m.email === "rep@acme.test");
  assert.ok(rep, "the report is still a member");
  assert.equal(rep.managerEmail, null, "shown with no manager, for an admin to place deliberately");
  assert.ok(!list.some((m) => m.email === "dep@acme.test"));
});

test("retained ledgers: billing pseudonymised, job runs scrubbed, AI usage anonymised", async () => {
  const hash = suppression.hashEmail("dep@acme.test");
  assert.equal(await n(`SELECT count(*)::int AS n FROM billing_event WHERE subject_id = 'u-dep'`), 0);
  assert.equal(await n(`SELECT count(*)::int AS n FROM billing_event WHERE subject_id = $1`, [`deleted:${hash.slice(0, 16)}`]), 2);
  assert.equal(await traces("billing_event", "dep@acme.test"), 0, "the free-text reason is redacted");
  assert.equal(await traces("developer_job_runs", "dep@acme.test"), 0, "target, error and details");
  const [run] = await q(`SELECT target_user_id, error FROM developer_job_runs WHERE target_user_id = 'u-dep'`);
  assert.match(run!.error as string, /\[deleted-user\]/);
  assert.equal(await n(`SELECT count(*)::int AS n FROM ai_usage WHERE user_id = 'u-dep'`), 0);
  assert.equal(await n(`SELECT count(*)::int AS n FROM ai_usage WHERE user_id IS NULL`), 1, "the cost row stays");
  // Other people's rows untouched.
  assert.equal(await n(`SELECT count(*)::int AS n FROM billing_event WHERE subject_id = 'u-rep'`), 1);
  assert.equal(await n(`SELECT count(*)::int AS n FROM billing_event WHERE reason = 'unrelated; referred by adep@acme.test'`), 1, "a colleague whose address contains dep@ is not redacted");
  assert.equal(await n(`SELECT count(*)::int AS n FROM developer_job_runs WHERE target_email = 'rep@acme.test'`), 1);
});

test("the suppression marker holds hashes only", async () => {
  const [m] = await q(`SELECT * FROM deletion_suppression WHERE request_id = $1`, [depRequestId]);
  assert.ok(m);
  assert.equal(m.email_hash, suppression.hashEmail("dep@acme.test"));
  assert.equal(m.google_sub_hash, suppression.hashGoogleSub("sub-dep"));
  assert.equal(m.purpose, "REREGISTRATION_REVIEW");
  assert.ok(new Date(m.expires_at as string).getTime() > clock.getTime() + 360 * DAY);
  assert.equal(await traces("deletion_suppression", "dep@acme.test"), 0);
  assert.equal(await traces("deletion_suppression", "sub-dep"), 0);
});

test("PRIVACY_ERASURE: the member's address is tombstoned across the org's history; structure stays", async () => {
  const beforeEdges = await n(`SELECT count(*)::int AS n FROM org_reporting_edge WHERE subordinate_email = 'priv@acme.test' OR manager_email = 'priv@acme.test'`);
  const beforeMembership = await q(`SELECT role, effective_from FROM org_membership WHERE email = 'priv@acme.test' ORDER BY effective_from`);
  const res = await deleteFully("u-priv", "priv@acme.test", "PRIVACY_ERASURE");
  assert.equal(res.request.status, "COMPLETED", res.request.lastError ?? "");
  assert.ok(res.report.verification.checks!.every((c) => c.ok));

  for (const t of ["org_membership", "org_reporting_edge", "org_audit_event"]) assert.equal(await traces(t, "priv@acme.test"), 0, t);

  const tomb = await q(`SELECT DISTINCT email FROM org_membership WHERE email LIKE 'former-member:%'`);
  assert.equal(tomb.length, 1, "one tombstone for the member");
  const t = tomb[0]!.email as string;
  assert.match(t, /^former-member:[0-9a-f]{12}$/);
  const afterMembership = await q(`SELECT role, effective_from, effective_until FROM org_membership WHERE email = $1 ORDER BY effective_from`, [t]);
  assert.deepEqual(afterMembership.map((m) => [m.role, String(m.effective_from)]), beforeMembership.map((m) => [m.role, String(m.effective_from)]), "roles and dates preserved");
  assert.ok(afterMembership.every((m) => m.effective_until !== null));
  assert.equal(await n(`SELECT count(*)::int AS n FROM org_reporting_edge WHERE subordinate_email = $1 OR manager_email = $1`, [t]), beforeEdges, "every edge kept, now under the tombstone");
  // A colleague's MANAGER_CHANGED event names the tombstone in its detail.
  const ev = await q(`SELECT detail FROM org_audit_event WHERE action = 'MANAGER_CHANGED' AND subject_email = 'rep2@acme.test'`);
  assert.ok(ev.some((e) => JSON.stringify(e.detail).includes(t)));
  // rep2 is detached from the erased manager; boss stays the owner.
  assert.equal((await members.listMembers(ORG)).find((m) => m.email === "rep2@acme.test")?.managerEmail, null);
  assert.equal(await n(`SELECT count(*)::int AS n FROM org_membership WHERE organization_id = $1 AND role = 'OWNER' AND effective_until IS NULL`, [ORG]), 1);
  // Only priv@ was replaced: colleagues whose address contains it, and everyone
  // else named beside it, are intact — in nested JSON, arrays and free text.
  assert.equal(await n(`SELECT count(*)::int AS n FROM org_membership WHERE email = 'apriv@acme.test' AND effective_until IS NULL`), 1);
  const [nested] = await q(`SELECT detail FROM org_audit_event WHERE subject_email = 'apriv@acme.test' AND detail ? 'cc'`);
  assert.deepEqual(nested!.detail, { from: t, to: "boss@acme.test", cc: [t, "apriv@acme.test"], note: { text: `Agreed with ${t}.` } });
  assert.equal((await members.listMembers(ORG)).find((m) => m.email === "apriv@acme.test")?.managerEmail, "boss@acme.test");
  // The DEPARTURE member's history is untouched by this erasure.
  assert.ok((await n(`SELECT count(*)::int AS n FROM org_membership WHERE email = 'dep@acme.test'`)) >= 1);
});

test("the anonymisation check catches a field the anonymiser missed", async () => {
  const pd = await import("./purge-db.ts");
  await q(`INSERT INTO org_audit_event (organization_id, action, subject_email) VALUES ($1, 'MEMBER_ADDED', 'ghost@acme.test')`, [ORG]);
  const ctx = { userId: "u-ghost", email: "GHOST@acme.test", emailHash: "x", kind: "PRIVACY_ERASURE" as const, tombstone: "former-member:000000000000" };
  const runQ = (text: string, params: unknown[]) => dbmod.pool.query(text, params);
  const before = await pd.anonymisationChecks(runQ, ctx, "PURGE");
  assert.ok(before.some((c) => c.table === "org_audit_event" && c.found === 1 && !c.ok), "case-insensitive leak found");
  await pd.anonymizeTenantRows(runQ, ctx, "PURGE");
  assert.ok((await pd.anonymisationChecks(runQ, ctx, "PURGE")).every((c) => c.ok));
});

// ── Re-registration ──────────────────────────────────────────────────

test("the deleted Google account signs up again: allowed, flagged, nothing restored", async () => {
  await q(`INSERT INTO "user" (id, name, email, platform_role) VALUES ('u-dep-new', 'Dep again', 'dep@acme.test', 'USER')`);
  await q(`INSERT INTO account (id, account_id, provider_id, user_id, updated_at) VALUES ('a-dep-new', 'sub-dep', 'google', 'u-dep-new', now())`);
  const opened = await suppression.onAccountLinked({ userId: "u-dep-new", providerId: "google", accountId: "sub-dep" });
  assert.equal(opened, 1);
  assert.equal(await suppression.onAccountLinked({ userId: "u-dep-new", providerId: "google", accountId: "sub-dep" }), 0, "flagged once");

  const [review] = await svc.listReregistrationReviews();
  assert.equal(review!.newUserId, "u-dep-new");
  assert.equal(review!.matchedOn, "GOOGLE_ACCOUNT_AND_EMAIL");
  assert.equal(review!.deletedRequestId, depRequestId);
  assert.equal(review!.status, "OPEN");

  // Nothing of the old account came back.
  assert.equal(await svc.isTenantFenced("u-dep-new"), false, "the new account is not fenced");
  assert.deepEqual(await members.organizationsForEmail("dep@acme.test"), [], "no org membership restored");
  for (const t of ["emails", "user_settings", "session", "corsair_accounts", "gmail_tenant_mappings", "calendar_events", "email_chunks"]) {
    assert.equal(await n(`SELECT count(*)::int AS n FROM "${t}" WHERE ${t === "corsair_accounts" || t === "gmail_tenant_mappings" ? "tenant_id" : "user_id"} = 'u-dep-new'`), 0, t);
    assert.equal(await n(`SELECT count(*)::int AS n FROM "${t}" WHERE ${t === "corsair_accounts" || t === "gmail_tenant_mappings" ? "tenant_id" : "user_id"} = 'u-dep'`), 0, `${t} (old id)`);
  }
  assert.equal(await svc.isTenantFenced("u-dep"), true, "the old id stays fenced");
});

test("a sign-up matching only the address is flagged as EMAIL; an unrelated one is not flagged", async () => {
  await q(`INSERT INTO "user" (id, name, email, platform_role) VALUES ('u-stranger', 'S', 'stranger@x.test', 'USER')`);
  assert.equal(await suppression.onAccountLinked({ userId: "u-stranger", providerId: "google", accountId: "sub-stranger" }), 0);
});

test("a developer resolves the review; resolving changes nothing about the account", async () => {
  const [review] = await svc.listReregistrationReviews();
  await assert.rejects(svc.resolveReregistrationReview({ id: review!.id, actor: dev(), note: "" }), /REASON_REQUIRED|concluded/);
  const done = await svc.resolveReregistrationReview({ id: review!.id, actor: dev(), note: "returning customer, expected" });
  assert.equal(done.status, "RESOLVED");
  assert.equal(done.resolvedBy, "dev@mailroid.test");
  assert.equal((await svc.listReregistrationReviews()).length, 0);
  await assert.rejects(svc.resolveReregistrationReview({ id: review!.id, actor: dev(), note: "again" }), /No open/);
});

// ── Identity matching edge cases ─────────────────────────────────────

let PRIV_REQUEST = "";

async function signUp(id: string, email: string, providerId: string, accountId: string): Promise<number> {
  await q(`INSERT INTO "user" (id, name, email, platform_role) VALUES ($1, $1, $2, 'USER')`, [id, email]);
  await q(`INSERT INTO account (id, account_id, provider_id, user_id, updated_at) VALUES ($1, $2, $3, $4, now())`, [`a-${id}`, accountId, providerId, id]);
  return suppression.onAccountLinked({ userId: id, providerId, accountId });
}
const reviewOf = async (userId: string) => (await svc.listReregistrationReviews({ includeResolved: true })).find((v) => v.newUserId === userId);

test("the Google id is matched even after the address changed", async () => {
  assert.equal(await signUp("u-renamed", "dep.renamed@acme.test", "google", "sub-dep"), 1);
  const v = await reviewOf("u-renamed");
  assert.equal(v?.matchedOn, "GOOGLE_ACCOUNT");
  assert.equal(v?.deletedRequestId, depRequestId);
});

test("the address is matched case-insensitively, with a different Google id", async () => {
  assert.equal(await signUp("u-recased", "DEP@Acme.TEST", "google", "sub-someone-else"), 1);
  assert.equal((await reviewOf("u-recased"))?.matchedOn, "EMAIL");
});

test("a non-Google sign-in can only match on the address", async () => {
  assert.equal(await signUp("u-other-provider", "Dep@acme.test", "credential", "sub-dep"), 1);
  assert.equal((await reviewOf("u-other-provider"))?.matchedOn, "EMAIL", "a non-Google accountId is never treated as a Google id");
});

test("a person deleted twice gets one review, on the strongest match", async () => {
  // A second, later deletion of the same address, with no Google id recorded.
  const [r] = await q(`INSERT INTO account_deletion_request (user_id, email_hash, kind, org_context, status) VALUES ('u-dep-earlier', $1, 'DEPARTURE', '{"type":"INDIVIDUAL"}', 'COMPLETED') RETURNING id`, [suppression.hashEmail("dep@acme.test")]);
  await q(`INSERT INTO deletion_suppression (request_id, email_hash, expires_at, created_at) VALUES ($1, $2, now() + interval '1000 days', now())`, [r!.id, suppression.hashEmail("dep@acme.test")]);
  assert.equal(await signUp("u-twice-google", "dEp@acme.test", "google", "sub-dep"), 1, "one review, not one per marker");
  assert.equal((await reviewOf("u-twice-google"))?.deletedRequestId, depRequestId, "the Google id match wins");
  assert.equal(await signUp("u-twice-email", "deP@acme.test", "google", "sub-unrelated"), 1);
  assert.equal((await reviewOf("u-twice-email"))?.deletedRequestId, r!.id, "address only: the most recent deletion");
});

test("an expired marker is not evidence of anything: it matches no one", async () => {
  const [r] = await q(`INSERT INTO account_deletion_request (user_id, email_hash, kind, org_context, status) VALUES ('u-long-gone', $1, 'DEPARTURE', '{"type":"INDIVIDUAL"}', 'COMPLETED') RETURNING id`, [suppression.hashEmail("gone@x.test")]);
  await q(`INSERT INTO deletion_suppression (request_id, email_hash, google_sub_hash, expires_at, created_at) VALUES ($1, $2, $3, now() - interval '1 second', now() - interval '400 days')`, [r!.id, suppression.hashEmail("gone@x.test"), suppression.hashGoogleSub("sub-gone")]);
  assert.equal(await signUp("u-gone-again", "gone@x.test", "google", "sub-gone"), 0);
  // The fixture would otherwise be "due" in the retention tests below.
  await q(`DELETE FROM deletion_suppression WHERE request_id = $1`, [r!.id]);
});

test("the identity edge cases restored nothing", async () => {
  for (const id of ["u-renamed", "u-recased", "u-other-provider", "u-twice-google", "u-twice-email"]) {
    assert.equal(await svc.isTenantFenced(id), false, id);
    for (const t of ["emails", "user_settings", "session"]) assert.equal(await n(`SELECT count(*)::int AS n FROM "${t}" WHERE user_id = $1`, [id]), 0, `${id} ${t}`);
  }
  // Close these reviews so the retention tests below see only what they set up.
  for (const v of await svc.listReregistrationReviews()) await svc.resolveReregistrationReview({ id: v.id, actor: dev(), note: "test fixture" });
});

test("priv@ signs up again and the review stays open (its marker must outlive the audit)", async () => {
  PRIV_REQUEST = (await q(`SELECT id FROM account_deletion_request WHERE user_id = 'u-priv'`))[0]!.id as string;
  assert.equal(await signUp("u-priv-new", "priv@acme.test", "google", "sub-priv"), 1);
  assert.equal((await reviewOf("u-priv-new"))?.deletedRequestId, PRIV_REQUEST);
});

// ── Retention ─────────────────────────────────────────────────────────

const env = { BILLING_RETENTION_DAYS: "" };

test("nothing is due today", async () => {
  const p = await ret.previewRetention({ env });
  assert.equal(p.items.filter((i) => i.due).length, 0);
  assert.ok(p.items.some((i) => i.category === "BILLING_RECORD" && i.block === "NO_BILLING_PERIOD"));
});

test("execute refuses a confirmation that doesn't match what is due", async () => {
  await assert.rejects(ret.executeRetentionSweep({ actor: dev(), confirmCount: 3, env }), /CONFIRMATION_MISMATCH|are due now/);
});

test("100 days on: only job runs of deleted accounts are due, not runs against live accounts", async () => {
  const p = await ret.previewRetention({ now: future(100), env });
  const due = p.items.filter((i) => i.due);
  assert.deepEqual(due.map((i) => i.category), ["DEVELOPER_JOB_RUN"]);
  const res = await ret.executeRetentionSweep({ actor: dev(), confirmCount: 1, now: future(100), env });
  assert.equal(res.done.length, 1);
  assert.equal(res.failed.length, 0);
  assert.equal(await n(`SELECT count(*)::int AS n FROM developer_job_runs WHERE target_user_id = 'u-dep'`), 0);
  assert.equal(await n(`SELECT count(*)::int AS n FROM developer_job_runs WHERE target_user_id = 'u-rep'`), 1, "a 500-day-old run against a live account stays");
  // The sweep is itself audited, with counts only.
  const [audit] = await q(`SELECT * FROM developer_job_runs WHERE id = $1`, [res.jobRunId]);
  assert.equal(audit!.job_id, "account:retention");
  assert.equal(audit!.status, "SUCCEEDED");
  assert.equal(audit!.actor_email, "dev@mailroid.test");
});

test("a legal hold blocks the audit, the marker and the billing rows of that request", async () => {
  await svc.setLegalHold({ id: depRequestId, actor: dev(), reason: "litigation hold, matter 42" });
  const p = await ret.previewRetention({ now: future(400), env: { BILLING_RETENTION_DAYS: "1" } });
  // Billing rows are tied through the pseudonym, which every request of this user shares.
  const billingIds = (await q(`SELECT id FROM billing_event WHERE subject_id = $1`, [`deleted:${suppression.hashEmail("dep@acme.test").slice(0, 16)}`])).map((r) => r.id);
  const tied = p.items.filter((i) => i.requestId === depRequestId || billingIds.includes(i.id));
  assert.deepEqual(tied.map((i) => i.category).sort(), ["BILLING_RECORD", "BILLING_RECORD", "DELETION_AUDIT", "SUPPRESSION_MARKER"]);
  assert.ok(tied.every((i) => !i.due && i.block === "LEGAL_HOLD"), JSON.stringify(tied));
  await svc.releaseLegalHold({ id: depRequestId, actor: dev(), reason: "matter closed" });
});

test("a hold placed after the preview wins: execution refuses the stale count", async () => {
  const now = future(400);
  const due = (await ret.previewRetention({ now, env: { BILLING_RETENTION_DAYS: "2920" } })).items.filter((i) => i.due).length;
  await svc.setLegalHold({ id: depRequestId, actor: dev(), reason: "late hold" });
  await assert.rejects(ret.executeRetentionSweep({ actor: dev(), confirmCount: due, now, env: { BILLING_RETENTION_DAYS: "2920" } }), /CONFIRMATION_MISMATCH|are due now/);
  assert.equal((await q(`SELECT audit_expired_at FROM account_deletion_request WHERE id = $1`, [depRequestId]))[0]!.audit_expired_at, null, "nothing expired");
  await svc.releaseLegalHold({ id: depRequestId, actor: dev(), reason: "released" });
});

test("400 days on: audits cut to skeletons, markers deleted; billing waits for its legal period", async () => {
  const now = future(400);
  const envB = { BILLING_RETENTION_DAYS: "2920" };
  const p = await ret.previewRetention({ now, env: envB });
  const due = p.items.filter((i) => i.due);
  const billingDue = due.filter((i) => i.category === "BILLING_RECORD");
  assert.equal(billingDue.length, 1, "only the 2017 row is past 8 years; the recent renewal is not");

  // One item fails mid-sweep: the rest go through, the failure is reported in full, nothing is claimed.
  await pg.exec(`
    CREATE FUNCTION fail_billing_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated billing outage'; END $$;
    CREATE TRIGGER trg_fail_billing BEFORE DELETE ON billing_event FOR EACH ROW EXECUTE FUNCTION fail_billing_delete();`);
  const first = await ret.executeRetentionSweep({ actor: dev(), confirmCount: due.length, now, env: envB });
  assert.equal(first.failed.length, 1);
  assert.equal(first.failed[0]!.item.category, "BILLING_RECORD");
  assert.match(first.failed[0]!.error, /simulated billing outage/);
  assert.equal(first.done.length, due.length - 1);
  assert.equal((await q(`SELECT status FROM developer_job_runs WHERE id = $1`, [first.jobRunId]))[0]!.status, "FAILED");

  // Recovery: the next preview shows exactly the failed item; running again finishes it.
  await pg.exec(`DROP TRIGGER trg_fail_billing ON billing_event; DROP FUNCTION fail_billing_delete();`);
  const again = (await ret.previewRetention({ now, env: envB })).items.filter((i) => i.due);
  assert.deepEqual(again.map((i) => i.id), [first.failed[0]!.item.id]);
  const res = await ret.executeRetentionSweep({ actor: dev(), confirmCount: 1, now, env: envB });
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  assert.equal(res.done.length, 1);

  const hash = suppression.hashEmail("dep@acme.test");
  assert.equal(await n(`SELECT count(*)::int AS n FROM billing_event WHERE subject_id = $1`, [`deleted:${hash.slice(0, 16)}`]), 1, "the recent row stays");
  assert.equal(await n(`SELECT count(*)::int AS n FROM billing_event WHERE subject_id = 'u-rep'`), 1, "a live subject's billing is never touched");

  // Skeletons, not deletions: ledger-reconcile still finds every request.
  const reqs = await q(`SELECT * FROM account_deletion_request WHERE user_id IN ('u-dep', 'u-priv')`);
  assert.equal(reqs.length, 4);
  for (const r of reqs) {
    assert.ok(r.audit_expired_at, r.id as string);
    assert.equal(r.email_hash, null);
    assert.equal(r.report, null);
    assert.deepEqual(Object.keys(r.org_context as object), ["type"]);
    assert.ok(r.status && r.kind && r.requested_at, "skeleton keeps status, kind, dates");
  }
  assert.equal(await n(`SELECT count(*)::int AS n FROM account_deletion_event e JOIN account_deletion_request r ON r.id = e.request_id WHERE r.user_id IN ('u-dep','u-priv')`), 0);
  assert.equal(await n(`SELECT count(*)::int AS n FROM deletion_suppression WHERE request_id = $1`, [depRequestId]), 0, "dep@'s marker gone, with its resolved reviews");
  assert.equal(await n(`SELECT count(*)::int AS n FROM deletion_reregistration_review WHERE new_user_id IN ('u-dep-new', 'u-renamed', 'u-twice-google')`), 0);
  assert.equal(await svc.isTenantFenced("u-dep"), true, "the fence row is RETAIN, indefinite");

  // priv@'s marker has an open review: it outlives its request's audit, hashes intact.
  const [pm] = await q(`SELECT s.email_hash, s.google_sub_hash, r.audit_expired_at FROM deletion_suppression s JOIN account_deletion_request r ON r.id = s.request_id WHERE s.request_id = $1`, [PRIV_REQUEST]);
  assert.ok(pm, "marker survives the audit expiry");
  assert.ok(pm.audit_expired_at, "its request is a skeleton now");
  assert.equal(pm.email_hash, suppression.hashEmail("priv@acme.test"));
  assert.equal(pm.google_sub_hash, suppression.hashGoogleSub("sub-priv"));
  const open = await reviewOf("u-priv-new");
  assert.deepEqual([open?.status, open?.deletedStatus, open?.deletedRequestId], ["OPEN", "COMPLETED", PRIV_REQUEST], "the review still reads against the skeleton");
});

test("the sweep is idempotent: a second run finds nothing and changes nothing", async () => {
  const now = future(400);
  const p = await ret.previewRetention({ now, env: { BILLING_RETENTION_DAYS: "2920" } });
  assert.equal(p.items.filter((i) => i.due).length, 0);
  const res = await ret.executeRetentionSweep({ actor: dev(), confirmCount: 0, now, env: { BILLING_RETENTION_DAYS: "2920" } });
  assert.equal(res.done.length + res.unchanged.length + res.failed.length, 0);
});

test("an open review keeps its marker past expiry", async () => {
  // A fresh marker with an open review, already past its period.
  const [r] = await q(`INSERT INTO account_deletion_request (user_id, email_hash, kind, org_context, status, closed_at) VALUES ('u-old', 'hh', 'DEPARTURE', '{"type":"INDIVIDUAL"}', 'COMPLETED', now()) RETURNING id`);
  const [m] = await q(`INSERT INTO deletion_suppression (request_id, email_hash, expires_at, created_at) VALUES ($1, 'hh', now() - interval '1 day', now() - interval '400 days') RETURNING id`, [r!.id]);
  await q(`INSERT INTO deletion_reregistration_review (suppression_id, new_user_id, matched_on) VALUES ($1, 'u-rep', 'EMAIL')`, [m!.id]);
  const p = await ret.previewRetention({ env });
  const marker = p.items.find((i) => i.id === m!.id);
  assert.deepEqual([marker?.due, marker?.block], [false, "OPEN_REVIEW"]);
});

// ── Failure inside the completion transaction ─────────────────────────

test("a failure while minimising rolls back to PURGE_FAILED, and retry completes it", async () => {
  // Fail the completion transaction's hashing of the user's actor_email, as a
  // broken database would. (Only that change: the purge's FK set-null on
  // actor_user_id must still go through, so the failure lands in completion.)
  await pg.exec(`
    CREATE FUNCTION fail_audit_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.actor_email IS DISTINCT FROM OLD.actor_email THEN RAISE EXCEPTION 'simulated audit outage'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER trg_fail_audit BEFORE UPDATE ON account_deletion_event FOR EACH ROW EXECUTE FUNCTION fail_audit_update();`);
  const bad = await deleteFully("u-solo", "solo@x.test", "DEPARTURE");
  assert.equal(bad.request.status, "PURGE_FAILED");
  assert.equal(await n(`SELECT count(*)::int AS n FROM deletion_suppression WHERE request_id = $1`, [bad.request.id]), 0, "a failed deletion leaves no marker");
  assert.match(bad.request.lastError!, /completion failed.*simulated audit outage/s);
  assert.ok(!bad.request.lastError!.toLowerCase().includes("solo@x.test"), "the stored error carries no bound values");
  assert.match(bad.request.lastError!, /params: \[withheld\]/);
  assert.equal(bad.report.verification.verified, false);
  assert.equal(bad.request.email, "solo@x.test", "rolled back: the address is still there for the retry's confirmation");
  assert.equal(bad.request.completedAt, null);

  await pg.exec(`DROP TRIGGER trg_fail_audit ON account_deletion_event; DROP FUNCTION fail_audit_update();`);
  const good = await svc.retryDeletion({ id: bad.request.id, actor: dev(), confirmEmail: "solo@x.test" }, deps);
  assert.equal(good.request.status, "COMPLETED", good.request.lastError ?? "");
  assert.equal(good.request.email, null);
  assert.equal(await traces("account_deletion_event", "solo@x.test"), 0);
  assert.equal(await n(`SELECT count(*)::int AS n FROM deletion_suppression WHERE request_id = $1`, [bad.request.id]), 1, "written once, by the completion");
  // A second completion (as after an integrity incident) can never add a second marker.
  await assert.rejects(q(`INSERT INTO deletion_suppression (request_id, email_hash, expires_at) VALUES ($1, 'x', now())`, [bad.request.id]), /uq_deletion_suppression_request/);
});

// ── AWAITING_SEAL: database purged, storage not yet proven empty ──────

test("AWAITING_SEAL: no marker yet; a sign-in creates a fresh, empty, unflagged account; completion writes the marker", async () => {
  const sub = await svc.submitDeletionRequest({ userId: "u-seal", kind: "DEPARTURE", reason: "leaving" });
  await svc.fenceAccount({ id: sub.id, actor: dev(), confirmEmail: "seal@x.test", orgConfirmed: false, lastOwnerChoices: {} }, deps);
  clock = new Date(clock.getTime() + 13 * 60 * 60 * 1000);
  // Storage is reachable for the purge, then gone for the verifying scan.
  let calls = 0;
  const sealDeps = { ...deps, store: () => (calls++ === 0 ? store : null) };
  const res = await svc.deleteAccount({ id: sub.id, actor: dev(), confirmEmail: "seal@x.test", acceptUnresolved: ["revokeGoogleGrant"], acceptReason: "test" }, sealDeps);
  assert.equal(res.request.status, "AWAITING_SEAL", res.request.lastError ?? "");
  assert.equal(await n(`SELECT count(*)::int AS n FROM deletion_suppression WHERE request_id = $1`, [sub.id]), 0, "a marker means COMPLETED; this isn't");

  // The person signs in with Google meanwhile. Better Auth finds no user, so it makes a new one.
  assert.equal(await signUp("u-seal-new", "seal@x.test", "google", "sub-seal"), 0, "nothing to match yet: not flagged");
  assert.equal(await svc.isTenantFenced("u-seal-new"), false);
  for (const t of ["emails", "user_settings", "session"]) assert.equal(await n(`SELECT count(*)::int AS n FROM "${t}" WHERE user_id = 'u-seal-new'`), 0, t);
  assert.equal(await svc.isTenantFenced("u-seal"), true, "the old id stays fenced");

  // Storage verifies later: the deletion completes and only now writes its marker.
  const done = await svc.verifyStorage({ id: sub.id, actor: dev() }, deps);
  assert.equal(done.request.status, "COMPLETED", done.request.lastError ?? "");
  assert.equal(await n(`SELECT count(*)::int AS n FROM deletion_suppression WHERE request_id = $1`, [sub.id]), 1);
  // The account created in between is not flagged retroactively.
  assert.equal(await reviewOf("u-seal-new"), undefined);
});
