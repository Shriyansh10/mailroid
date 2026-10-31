import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// @ts-ignore – schema.ts is ts-nocheck re-exports
import * as schema from "@repo/database/schema";

import { FENCE_TRIGGER_TABLES, INVENTORY, PURGE_ORDER, tenantPredicate } from "./inventory.ts";

// drizzle-orm is not a direct dependency of this package, so tables are
// recognised by the symbols drizzle stamps on them rather than `is(PgTable)`.
const NAME = Symbol.for("drizzle:Name");
const IS_TABLE = Symbol.for("drizzle:IsDrizzleTable");
const schemaTables = Object.values(schema as Record<string, unknown>)
  .filter((v): v is Record<symbol, unknown> => typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[IS_TABLE] === true)
  .map((t) => String(t[NAME]))
  .sort();

test("every table in the schema is classified — a new table can't hide user data", () => {
  // Guard against a vacuous pass if table detection ever stops matching.
  assert.ok(schemaTables.length >= 40, `only ${schemaTables.length} tables detected`);
  assert.ok(schemaTables.includes("message_metadata") && schemaTables.includes("user"));
  const unknown = schemaTables.filter((t) => !INVENTORY[t]);
  assert.deepEqual(unknown, [], `UNKNOWN tables, add them to inventory.ts: ${unknown.join(", ")}`);
});

test("the inventory names no table that doesn't exist", () => {
  const ghosts = Object.keys(INVENTORY).filter((t) => !schemaTables.includes(t));
  assert.deepEqual(ghosts, []);
});

test("every purgeable table is in the purge order, and only those", () => {
  const purgeable = Object.entries(INVENTORY)
    .filter(([, e]) => ["FENCED", "AUTH_MANAGED", "CREDENTIAL_HELD", "OPERATOR_CONTROL"].includes(e.cls))
    .map(([t]) => t)
    .sort();
  assert.deepEqual([...PURGE_ORDER].sort(), purgeable);
  assert.equal(PURGE_ORDER[PURGE_ORDER.length - 1], "user", "the user row goes last");
  assert.ok(PURGE_ORDER.indexOf("corsair_accounts") > PURGE_ORDER.indexOf("corsair_entities"));
  assert.ok(PURGE_ORDER.indexOf("conversations") > PURGE_ORDER.indexOf("assistant_messages"));
});

test("the trigger migration covers exactly the fenced tables", () => {
  const sqlPath = fileURLToPath(new URL("../../database/drizzle/0056_tenant_fence_trigger.sql", import.meta.url));
  const text = readFileSync(sqlPath, "utf8");
  const triggered = [...text.matchAll(/CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(triggered, [...FENCE_TRIGGER_TABLES]);
  // Credential tables, and only those, may be updated while fenced.
  const allow = [...text.matchAll(/ON "([a-z_]+)"\n {2}FOR EACH ROW EXECUTE FUNCTION assert_tenant_write\('allow_update'/g)].map((m) => m[1]).sort();
  const credential = Object.entries(INVENTORY).filter(([, e]) => e.cls === "CREDENTIAL_HELD").map(([t]) => t).sort();
  assert.deepEqual(allow, credential);
});

// ── Dispositions ─────────────────────────────────────────────────────

const DISPOSITIONS = ["DELETE", "RETAIN", "ANONYMIZE", "RESTRICTED"];

test("every entry declares a valid disposition", () => {
  const bad = Object.entries(INVENTORY)
    .filter(([, e]) => !DISPOSITIONS.includes(e.disposition as string))
    .map(([t, e]) => `${t}: ${String(e.disposition)}`);
  assert.deepEqual(bad, []);
});

test("purged tables are DELETE, and only purged tables are DELETE", () => {
  for (const [t, e] of Object.entries(INVENTORY)) {
    const purged = PURGE_ORDER.includes(t);
    assert.equal(e.disposition === "DELETE", purged, `${t}: ${e.disposition} but ${purged ? "" : "not "}in the purge order`);
  }
});

test("RETAIN and RESTRICTED entries say why, for how long, and (RESTRICTED) who can read them", () => {
  const missing: string[] = [];
  for (const [t, e] of Object.entries(INVENTORY)) {
    if (e.disposition !== "RETAIN" && e.disposition !== "RESTRICTED") continue;
    const r = e.retention;
    if (!r?.purpose?.trim()) missing.push(`${t}: purpose`);
    if (!r?.period?.trim()) missing.push(`${t}: period`);
    if (!r?.whyKept?.trim()) missing.push(`${t}: whyKept`);
    if (e.disposition === "RESTRICTED" && !r?.access?.trim()) missing.push(`${t}: access`);
  }
  assert.deepEqual(missing, []);
});

test("ANONYMIZE entries name the fields they clear, and every field spec is well formed", () => {
  const problems: string[] = [];
  for (const [t, e] of Object.entries(INVENTORY)) {
    if (e.disposition === "ANONYMIZE" && !e.anonymize?.length) problems.push(`${t}: ANONYMIZE without fields`);
    if (e.disposition === "DELETE" && e.anonymize?.length) problems.push(`${t}: DELETE table with anonymize fields`);
    for (const f of e.anonymize ?? []) {
      if (!/^[a-z_]+$/.test(f.column)) problems.push(`${t}.${f.column}: bad column name`);
      if (!f.why?.trim()) problems.push(`${t}.${f.column}: no why`);
      if (f.scope === "TENANT" && !e.tenant) problems.push(`${t}.${f.column}: TENANT scope on a table with no tenant mapping`);
      if (f.action === "STRIP_KEYS" && (!f.path || !f.keys?.length)) problems.push(`${t}.${f.column}: STRIP_KEYS without path/keys`);
      if (f.identifies === "THIRD_PARTY" && f.action !== "STRIP_KEYS") problems.push(`${t}.${f.column}: THIRD_PARTY must STRIP_KEYS`);
      if (f.action === "PSEUDONYMISE" && f.identifies !== "USER_ID") problems.push(`${t}.${f.column}: PSEUDONYMISE applies to the user id`);
    }
  }
  assert.deepEqual(problems, []);
});

test("every anonymised column exists in its table", () => {
  const byName = new Map(
    Object.values(schema as Record<string, unknown>)
      .filter((v): v is Record<symbol, unknown> => typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[IS_TABLE] === true)
      .map((tbl) => [String(tbl[NAME]), tbl]),
  );
  const COLUMNS = Symbol.for("drizzle:Columns");
  const missing: string[] = [];
  for (const [t, e] of Object.entries(INVENTORY)) {
    for (const f of e.anonymize ?? []) {
      const cols = Object.values((byName.get(t)?.[COLUMNS] ?? {}) as Record<string, { name: string }>).map((c) => c.name);
      if (!cols.includes(f.column)) missing.push(`${t}.${f.column}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the classification the owner set is the one in the inventory", () => {
  const d = (t: string) => INVENTORY[t]!.disposition;
  assert.equal(d("ai_usage"), "ANONYMIZE");
  assert.equal(d("billing_event"), "RETAIN");
  assert.equal(d("developer_job_runs"), "RESTRICTED");
  for (const t of ["org_membership", "org_reporting_edge", "org_audit_event"]) assert.equal(d(t), "RETAIN", t);
  assert.equal(d("account_deletion_request"), "RESTRICTED");
  assert.equal(d("account_deletion_event"), "RESTRICTED");
  assert.equal(d("tenant_epoch"), "RETAIN");
  assert.equal(d("deletion_suppression"), "RETAIN");
  // Org history is anonymised only for PRIVACY_ERASURE: DEPARTURE keeps it as the org's record.
  for (const t of ["org_membership", "org_reporting_edge"]) {
    assert.ok(INVENTORY[t]!.anonymize!.every((f) => f.when === "PRIVACY_ERASURE"), t);
  }
});

test("tenant predicates are parameterised and resolve parents", () => {
  assert.equal(tenantPredicate("emails"), "user_id = $1");
  assert.equal(tenantPredicate("user"), "id = $1");
  assert.equal(tenantPredicate("subscription"), "subject_type = 'USER' AND subject_id = $1");
  assert.equal(
    tenantPredicate("corsair_entities"),
    `account_id IN (SELECT id FROM "corsair_accounts" WHERE tenant_id = $1)`,
  );
  assert.throws(() => tenantPredicate("organization"));
});
