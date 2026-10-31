/**
 * Every migration, in journal order, applied to an empty in-process Postgres
 * (PGlite + pgvector). Proves the account-deletion migrations (0055, 0056)
 * apply cleanly on top of the real schema, and that the fence trigger ends up
 * on every table the inventory requires — the same check `account:delete`
 * runs against the live database before it will purge anything.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

import { FENCE_TRIGGER_TABLES } from "./inventory.ts";

const dir = fileURLToPath(new URL("../../database/drizzle/", import.meta.url));
const journal = JSON.parse(readFileSync(`${dir}meta/_journal.json`, "utf8")) as { entries: { tag: string }[] };

test("all migrations apply, and the fence covers every inventory table", { timeout: 120_000 }, async () => {
  const pg = new PGlite({ extensions: { vector } });
  // Production creates the extension outside the migrations.
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector");
  for (const { tag } of journal.entries) {
    const text = readFileSync(`${dir}${tag}.sql`, "utf8");
    for (const stmt of text.split("--> statement-breakpoint")) {
      if (!stmt.trim()) continue;
      try {
        await pg.exec(stmt);
      } catch (err) {
        throw new Error(`${tag}: ${(err as Error).message}\n${stmt.slice(0, 300)}`);
      }
    }
  }
  const res = await pg.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_trigger tr JOIN pg_class c ON c.oid = tr.tgrelid WHERE tr.tgname = 'trg_tenant_fence'`,
  );
  assert.deepEqual(res.rows.map((r) => r.t).sort(), [...FENCE_TRIGGER_TABLES]);

  // The actor CHECK on the audit table holds.
  await pg.exec(`INSERT INTO account_deletion_request (id, user_id, email_hash, kind, reason, org_context) VALUES ('00000000-0000-0000-0000-000000000001', 'u1', 'h', 'DEPARTURE', 'leaving', '{"type":"INDIVIDUAL"}')`);
  await assert.rejects(
    pg.exec(`INSERT INTO account_deletion_event (request_id, type, actor_type) VALUES ('00000000-0000-0000-0000-000000000001', 'X', 'DEVELOPER')`),
    /actor_check/,
  );
  await pg.exec(`INSERT INTO account_deletion_event (request_id, type, actor_type) VALUES ('00000000-0000-0000-0000-000000000001', 'X', 'SYSTEM')`);

  // One open request per user.
  await assert.rejects(
    pg.exec(`INSERT INTO account_deletion_request (user_id, email_hash, kind, reason, org_context) VALUES ('u1', 'h', 'DEPARTURE', 'again', '{"type":"INDIVIDUAL"}')`),
    /uq_deletion_request_open/,
  );
  // 0057/0058: suppression and review constraints.
  const REQ = "00000000-0000-0000-0000-000000000002";
  await pg.exec(`INSERT INTO account_deletion_request (id, user_id, email_hash, kind, org_context, status) VALUES ('${REQ}', 'u2', 'h2', 'DEPARTURE', '{"type":"INDIVIDUAL"}', 'COMPLETED')`);
  await pg.exec(`INSERT INTO deletion_suppression (id, request_id, email_hash, expires_at) VALUES ('00000000-0000-0000-0000-0000000000f1', '${REQ}', 'h2', now() + interval '1 day')`);
  await assert.rejects(pg.exec(`INSERT INTO deletion_suppression (request_id, email_hash, expires_at) VALUES ('${REQ}', 'h2', now())`), /uq_deletion_suppression_request/, "one marker per request");
  await assert.rejects(pg.exec(`DELETE FROM account_deletion_request WHERE id = '${REQ}'`), /foreign key/, "a request with a marker can't be deleted out from under it");
  await assert.rejects(pg.exec(`INSERT INTO deletion_suppression (request_id, email_hash, expires_at) VALUES ('00000000-0000-0000-0000-00000000dead', 'h', now())`), /foreign key/);
  await pg.exec(`INSERT INTO "user" (id, name, email) VALUES ('nu', 'n', 'n@x.test')`);
  await pg.exec(`INSERT INTO deletion_reregistration_review (suppression_id, new_user_id, matched_on) VALUES ('00000000-0000-0000-0000-0000000000f1', 'nu', 'EMAIL')`);
  await assert.rejects(
    pg.exec(`INSERT INTO deletion_suppression (id, request_id, email_hash, expires_at) VALUES ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-000000000001', 'h', now());
             INSERT INTO deletion_reregistration_review (suppression_id, new_user_id, matched_on) VALUES ('00000000-0000-0000-0000-0000000000f2', 'nu', 'EMAIL')`),
    /uq_reregistration_review_user/,
    "one review per new account",
  );
  // The audit skeleton keeps the marker valid: nulling the request's hashes is not deleting it.
  await pg.exec(`UPDATE account_deletion_request SET email_hash = NULL, google_sub_hash = NULL, audit_expired_at = now() WHERE id = '${REQ}'`);
  assert.equal((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM deletion_suppression WHERE request_id = '${REQ}' AND email_hash = 'h2'`)).rows[0]!.n, 1);
  // Deleting the marker takes its reviews with it.
  await pg.exec(`DELETE FROM deletion_suppression WHERE id = '00000000-0000-0000-0000-0000000000f1'`);
  assert.equal((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM deletion_reregistration_review`)).rows[0]!.n, 0);
  await pg.close();
});
