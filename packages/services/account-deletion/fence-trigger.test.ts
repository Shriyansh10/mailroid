/**
 * The fence trigger, run for real: the plpgsql from the 0056 migration
 * executed by PGlite (Postgres compiled to WASM, in-process). No database
 * server, no network, nothing touched outside this process.
 *
 * Only the tables the cases need are created, as stubs with the columns the
 * trigger reads; the function and trigger statements are taken verbatim from
 * the migration file.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  fileURLToPath(new URL("../../database/drizzle/0056_tenant_fence_trigger.sql", import.meta.url)),
  "utf8",
);
const statements = migration.split("--> statement-breakpoint").map((s) => s.trim());
const fnSql = statements.find((s) => s.includes("CREATE OR REPLACE FUNCTION assert_tenant_write"))!;
const triggerFor = (table: string) => statements.find((s) => s.startsWith(`CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "${table}"`))!;

let pg: PGlite;

before(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE tenant_fence_state AS ENUM ('ACTIVE', 'FENCED');
    CREATE TABLE tenant_epoch (tenant_id text PRIMARY KEY, epoch int NOT NULL DEFAULT 0, state tenant_fence_state NOT NULL DEFAULT 'ACTIVE', ever_fenced boolean NOT NULL DEFAULT false);
    CREATE TABLE "user" (id text PRIMARY KEY, email text);
    CREATE TABLE session (id text PRIMARY KEY, user_id text NOT NULL);
    CREATE TABLE emails (id serial PRIMARY KEY, user_id text NOT NULL, body text);
    CREATE TABLE corsair_accounts (id text PRIMARY KEY, tenant_id text NOT NULL, config text);
    CREATE TABLE corsair_entities (id text PRIMARY KEY, account_id text NOT NULL REFERENCES corsair_accounts(id), data text);
    CREATE TABLE gmail_tenant_mappings (email_address text PRIMARY KEY, tenant_id text NOT NULL, watch_topic text);
  `);
  await pg.exec(fnSql);
  for (const t of ["user", "session", "emails", "corsair_accounts", "corsair_entities", "gmail_tenant_mappings"]) {
    const sql = triggerFor(t);
    assert.ok(sql, `migration has a trigger for ${t}`);
    await pg.exec(sql);
  }
  await pg.exec(`
    INSERT INTO "user" VALUES ('u1', 'a@x.com'), ('u2', 'b@x.com');
    INSERT INTO emails (user_id, body) VALUES ('u1', 'hello'), ('u2', 'hi');
    INSERT INTO corsair_accounts VALUES ('acc1', 'u1', 'tok'), ('acc2', 'u2', 'tok');
    INSERT INTO corsair_entities VALUES ('e1', 'acc1', 'x');
    INSERT INTO gmail_tenant_mappings VALUES ('a@x.com', 'u1', 'topic');
    INSERT INTO tenant_epoch (tenant_id, epoch, state, ever_fenced) VALUES ('u1', 1, 'FENCED', true);
  `);
});

const rejects = async (sql: string, re = /TENANT_FENCED/) => {
  await assert.rejects(pg.exec(sql), (err: Error) => re.test(err.message));
};

test("INSERT for a fenced tenant is rejected", async () => {
  await rejects(`INSERT INTO emails (user_id, body) VALUES ('u1', 'late mail')`);
  await rejects(`INSERT INTO session VALUES ('s-late', 'u1')`);
});

test("UPDATE of content for a fenced tenant is rejected", async () => {
  await rejects(`UPDATE emails SET body = 'changed' WHERE user_id = 'u1'`);
  await rejects(`UPDATE "user" SET email = 'c@x.com' WHERE id = 'u1'`);
});

test("an unfenced tenant is unaffected", async () => {
  await pg.exec(`INSERT INTO emails (user_id, body) VALUES ('u2', 'fine')`);
  await pg.exec(`UPDATE emails SET body = 'fine too' WHERE user_id = 'u2'`);
  const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM emails WHERE user_id = 'u2'`);
  assert.equal(r.rows[0]!.n, 2);
});

test("DELETE is always allowed — the purge is only deletes", async () => {
  await pg.exec(`INSERT INTO emails (user_id, body) VALUES ('u3', 'tmp')`);
  await pg.exec(`INSERT INTO tenant_epoch (tenant_id, state) VALUES ('u3', 'FENCED')`);
  await pg.exec(`DELETE FROM emails WHERE user_id = 'u3'`);
  const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM emails WHERE user_id = 'u3'`);
  assert.equal(r.rows[0]!.n, 0);
});

test("credential tables accept UPDATE (token refresh during revoke) but not INSERT", async () => {
  await pg.exec(`UPDATE corsair_accounts SET config = 'refreshed' WHERE tenant_id = 'u1'`);
  await pg.exec(`UPDATE gmail_tenant_mappings SET watch_topic = NULL WHERE tenant_id = 'u1'`);
  await rejects(`INSERT INTO corsair_accounts VALUES ('acc-new', 'u1', 'tok')`);
});

test("corsair_entities resolve their tenant through the parent account", async () => {
  await rejects(`INSERT INTO corsair_entities VALUES ('e-late', 'acc1', 'cached mail')`);
  await rejects(`UPDATE corsair_entities SET data = 'y' WHERE id = 'e1'`);
  await pg.exec(`INSERT INTO corsair_entities VALUES ('e-ok', 'acc2', 'x')`);
});

test("the deletion capability lets the deletion service write for exactly that tenant", async () => {
  await pg.exec(`
    BEGIN;
    SET LOCAL mailroid.deletion_capability = 'u1';
    UPDATE emails SET body = 'scrubbed' WHERE user_id = 'u1';
    COMMIT;
  `);
  // The capability is transaction-local: gone after COMMIT.
  await rejects(`UPDATE emails SET body = 'again' WHERE user_id = 'u1'`);
  // And it names one tenant — it does not open others.
  await pg.exec(`INSERT INTO tenant_epoch (tenant_id, state) VALUES ('u4', 'FENCED')`);
  await assert.rejects(
    pg.exec(`BEGIN; SET LOCAL mailroid.deletion_capability = 'u1'; INSERT INTO emails (user_id, body) VALUES ('u4', 'x'); COMMIT;`),
    /TENANT_FENCED/,
  );
  await pg.exec(`ROLLBACK`).catch(() => undefined);
});

test("unfencing (cancel) restores writes", async () => {
  await pg.exec(`UPDATE tenant_epoch SET state = 'ACTIVE', epoch = epoch + 1 WHERE tenant_id = 'u1'`);
  await pg.exec(`INSERT INTO emails (user_id, body) VALUES ('u1', 'back')`);
  await pg.exec(`UPDATE tenant_epoch SET state = 'FENCED', epoch = epoch + 1 WHERE tenant_id = 'u1'`);
});

test("with nobody fenced, the fast path admits everything", async () => {
  await pg.exec(`UPDATE tenant_epoch SET state = 'ACTIVE'`);
  await pg.exec(`INSERT INTO emails (user_id, body) VALUES ('u1', 'fast')`);
  await pg.exec(`INSERT INTO corsair_entities VALUES ('e-fast', 'acc1', 'x')`);
});
