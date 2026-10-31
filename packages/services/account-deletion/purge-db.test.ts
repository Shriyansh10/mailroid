/**
 * The database purge, run for real on the full migrated schema (PGlite).
 *
 * Seeds one row per purgeable table for two users — generically, from
 * information_schema, so a new column or table is covered without editing
 * this file — fences user A, purges A, and checks:
 *   - nothing of A remains in any inventory table;
 *   - every row of B is still there;
 *   - the fence trigger did not block the purge (it only deletes);
 *   - foreign keys never refused a delete (the order is right).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

import { INVENTORY, PURGE_ORDER } from "./inventory.ts";
import { purgeTenantRows, remainingTenantRows, type Query } from "./purge-db.ts";

const dir = fileURLToPath(new URL("../../database/drizzle/", import.meta.url));
const REQUEST_ID = "00000000-0000-0000-0000-00000000d001";
const SUPPRESSION_ID = "00000000-0000-0000-0000-00000000d002";
let pg: PGlite;
let q: Query;

type Col = { column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null };
type Fk = { table_name: string; column_name: string; ref_table: string; ref_column: string };

/** Insert order: parents first. The purge order reversed is exactly that. */
const SEED_ORDER = [...PURGE_ORDER].reverse();

async function seedUser(userId: string, n: number): Promise<void> {
  const fks = (
    await pg.query<Fk>(`
      SELECT kcu.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'`)
  ).rows;
  // Shared parents that are not per-user data.
  const inserted = new Map<string, Record<string, unknown>>([
    ["corsair_integrations", { id: "integration-1" }],
    ["deletion_suppression", { id: SUPPRESSION_ID }],
  ]);

  for (const table of SEED_ORDER) {
    const entry = INVENTORY[table]!;
    const cols = (
      await pg.query<Col>(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [table],
      )
    ).rows;
    const values: Record<string, unknown> = {};
    for (const c of cols) {
      const fk = fks.find((f) => f.table_name === table && f.column_name === c.column_name);
      if (fk && inserted.has(fk.ref_table)) {
        values[c.column_name] = inserted.get(fk.ref_table)![fk.ref_column];
        continue;
      }
      if (entry.tenant && "column" in entry.tenant && entry.tenant.column === c.column_name) {
        values[c.column_name] = userId;
        continue;
      }
      if (c.is_nullable === "YES" || c.column_default !== null) continue;
      values[c.column_name] = await sampleValue(c, `${table}-${n}`);
    }
    if (table === "subscription") values.subject_type = "USER";
    const names = Object.keys(values);
    const res = await pg.query<Record<string, unknown>>(
      `INSERT INTO "${table}" (${names.map((x) => `"${x}"`).join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      names.map((k) => values[k]),
    );
    inserted.set(table, res.rows[0]!);
  }
}

async function sampleValue(c: Col, tag: string): Promise<unknown> {
  switch (c.data_type) {
    case "text":
    case "character varying":
      return `${c.column_name}-${tag}`;
    case "uuid":
      return crypto.randomUUID();
    case "integer":
    case "bigint":
    case "smallint":
    case "real":
    case "double precision":
    case "numeric":
      return 1;
    case "boolean":
      return false;
    case "jsonb":
    case "json":
      return "{}";
    case "date":
      return "2026-10-28";
    case "timestamp with time zone":
    case "timestamp without time zone":
      return new Date();
    case "ARRAY":
      return "{}";
    case "USER-DEFINED": {
      if (c.udt_name === "vector") return `[${Array(1536).fill(0).join(",")}]`;
      const r = await pg.query<{ v: string }>(`SELECT unnest(enum_range(NULL::"${c.udt_name}"))::text AS v LIMIT 1`);
      return r.rows[0]!.v;
    }
    default:
      throw new Error(`seed: no sample for ${c.column_name} (${c.data_type}/${c.udt_name})`);
  }
}

/** Rows per table for a user (tables with none are omitted). */
const countAll = (userId: string) => remainingTenantRows(q, userId);

before(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.exec("CREATE EXTENSION IF NOT EXISTS vector");
  const journal = JSON.parse(readFileSync(`${dir}meta/_journal.json`, "utf8")) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    for (const stmt of readFileSync(`${dir}${tag}.sql`, "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  q = async (text, params) => {
    const res = await pg.query<Record<string, unknown>>(text, params as unknown[]);
    return { rows: res.rows, affectedRows: res.affectedRows };
  };
  await pg.exec(`INSERT INTO corsair_integrations (id, name) VALUES ('integration-1', 'gmail')`);
  // Shared parent of deletion_reregistration_review: a marker from some earlier deletion.
  await pg.exec(`
    INSERT INTO account_deletion_request (id, user_id, email_hash, kind, reason, org_context, status)
      VALUES ('${REQUEST_ID}', 'gone', 'h', 'DEPARTURE', 'x', '{"type":"INDIVIDUAL"}', 'COMPLETED');
    INSERT INTO deletion_suppression (id, request_id, email_hash, expires_at)
      VALUES ('${SUPPRESSION_ID}', '${REQUEST_ID}', 'h', now() + interval '1 day');`);
  await seedUser("user-a", 1);
  await seedUser("user-b", 2);
});

test("seeding put a row for both users in every purgeable table", async () => {
  const a = await countAll("user-a");
  const b = await countAll("user-b");
  assert.deepEqual(Object.keys(a).sort(), [...PURGE_ORDER].sort());
  assert.deepEqual(Object.keys(b).sort(), [...PURGE_ORDER].sort());
});

test("while fenced, A cannot be written to — but can be purged", async () => {
  await pg.exec(`INSERT INTO tenant_epoch (tenant_id, epoch, state, ever_fenced) VALUES ('user-a', 1, 'FENCED', true)`);
  await assert.rejects(pg.query(`UPDATE user_settings SET user_id = user_id WHERE user_id = 'user-a'`), /TENANT_FENCED/);

  const deleted = await purgeTenantRows(q, "user-a");
  for (const t of PURGE_ORDER) assert.ok((deleted[t] ?? 0) >= 0, t);
  assert.deepEqual(await remainingTenantRows(q, "user-a"), {}, "nothing of A remains");
});

test("B is untouched", async () => {
  const b = await countAll("user-b");
  assert.deepEqual(Object.keys(b).sort(), [...PURGE_ORDER].sort());
  for (const [t, n] of Object.entries(b)) assert.ok(n >= 1, t);
});

test("re-running the purge is a no-op", async () => {
  const again = await purgeTenantRows(q, "user-a");
  assert.equal(Object.values(again).reduce((x, y) => x + y, 0), 0);
});

test("the fence row survives the purge, so late writes for A stay rejected", async () => {
  const r = await pg.query<{ state: string }>(`SELECT state FROM tenant_epoch WHERE tenant_id = 'user-a'`);
  assert.equal(r.rows[0]?.state, "FENCED");
  await assert.rejects(
    pg.query(`INSERT INTO gmail_sync_status (user_id) VALUES ('user-a')`),
    // BEFORE triggers run ahead of NOT NULL checks, so the fence answers first.
    /TENANT_FENCED/,
  );
});
