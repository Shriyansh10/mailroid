/**
 * The database half of the purge, written against a bare `query` function so
 * the same code runs on the live pool and on PGlite in the tests
 * (purge-db.test.ts seeds every purgeable table and runs it for real).
 */

import { INVENTORY, PURGE_ORDER, tenantPredicate, type AnonField, type Disposition } from "./inventory.ts";

export type Query = (text: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null; affectedRows?: number }>;

const BATCH = 5000;

const affected = (r: { rowCount?: number | null; affectedRows?: number }) => r.rowCount ?? r.affectedRows ?? 0;

/**
 * Delete this tenant's rows from every purgeable table, in inventory order,
 * in batches so no single statement holds locks for long. Idempotent: a
 * re-run after a failure deletes whatever is left and nothing else.
 */
export async function purgeTenantRows(query: Query, userId: string): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const table of PURGE_ORDER) {
    const pred = tenantPredicate(table);
    let total = 0;
    for (;;) {
      const res = await query(
        `DELETE FROM "${table}" WHERE ctid IN (SELECT ctid FROM "${table}" WHERE ${pred} LIMIT ${BATCH})`,
        [userId],
      );
      total += affected(res);
      if (affected(res) < BATCH) break;
    }
    deleted[table] = total;
  }
  return deleted;
}

/** Rows still present for this tenant, per table. Empty object = clean. */
export async function remainingTenantRows(query: Query, userId: string): Promise<Record<string, number>> {
  const remaining: Record<string, number> = {};
  for (const table of PURGE_ORDER) {
    const res = await query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${tenantPredicate(table)}`, [userId]);
    const n = Number(res.rows[0]?.n ?? 0);
    if (n > 0) remaining[table] = n;
  }
  return remaining;
}

// ── Anonymisation and retention, driven by the inventory ──────────────

export type DeletionKind = "DEPARTURE" | "PRIVACY_ERASURE";

/** Everything the anonymiser needs to know about the deleted account. */
export interface AnonContext {
  userId: string;
  email: string;
  emailHash: string;
  kind: DeletionKind;
  /** `former-member:<random>`, one per deletion. */
  tombstone: string;
}

export const REDACTED = "[deleted-user]";

/** The pseudonym billing keeps for a deleted subject. */
export function billingPseudonym(emailHash: string): string {
  return `deleted:${emailHash.slice(0, 16)}`;
}

export interface AnonTarget {
  table: string;
  field: AnonField;
}

/** Every inventory field that applies to this kind of deletion in this phase. */
export function anonTargets(kind: DeletionKind, phase: "PURGE" | "COMPLETE"): AnonTarget[] {
  const out: AnonTarget[] = [];
  for (const [table, e] of Object.entries(INVENTORY)) {
    for (const field of e.anonymize ?? []) {
      if ((field.phase ?? "PURGE") !== phase) continue;
      if (field.when === "PRIVACY_ERASURE" && kind !== "PRIVACY_ERASURE") continue;
      out.push({ table, field });
    }
  }
  return out;
}

const IDENT_RE = /^[a-z_]+$/;

function assertField(table: string, field: AnonField): void {
  for (const n of [table, field.column, ...(field.path ? [field.path] : [])]) {
    if (!IDENT_RE.test(n)) throw new Error(`[account-deletion] bad identifier ${n}`);
  }
}

/** The row filter a field works within: the tenant's rows, or the whole table. */
function scopeOf(table: string, field: AnonField): string {
  const e = INVENTORY[table]!;
  const scope = field.scope ?? (e.tenant ? "TENANT" : "TABLE");
  // TABLE still names $1: Postgres refuses a parameter it cannot type, and
  // every statement here passes the user id first.
  return scope === "TENANT" ? `(${tenantPredicate(table)})` : "($1::text IS NOT NULL)";
}

/** Matches the user id: through the tenant predicate when the field IS the tenant column. */
function userIdMatch(table: string, field: AnonField): string {
  const e = INVENTORY[table]!;
  const isTenantCol = !!e.tenant && "column" in e.tenant && e.tenant.column === field.column;
  return isTenantCol ? `(${tenantPredicate(table)})` : `"${field.column}" = $1`;
}

/**
 * A Postgres ARE pattern matching the address as a whole address, as it
 * appears in text or in JSON — never as part of a longer one. A plain
 * substring match would treat a colleague's `apriv@acme.test` as containing
 * `priv@acme.test`: the anonymiser would corrupt their address, and the check
 * would flag their row for ever, so the deletion could never complete.
 *
 *   before: not an address character  [A-Za-z0-9._%+-]
 *   after:  not a domain character, and not a dot that continues the domain
 *           (a sentence-ending "." after the address still matches)
 */
export function emailPattern(email: string, json: boolean): string {
  const s = json ? JSON.stringify(email).slice(1, -1) : email;
  const literal = s.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");
  return `(?<![A-Za-z0-9._%+-])${literal}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`;
}

/**
 * The UPDATE for one field. `$1` is always the user id; `$2` the address, its
 * pattern (emailPattern) or the key list; `$3` the replacement.
 */
export function anonStatement(table: string, field: AnonField, ctx: AnonContext): { text: string; params: unknown[] } {
  assertField(table, field);
  const col = `"${field.column}"`;
  const t = `"${table}"`;
  const scope = scopeOf(table, field);
  const pattern = emailPattern(ctx.email, !!field.json);
  const containsEmail = `${col}::text ~* $2`;

  switch (field.action) {
    case "NULL":
      if (field.identifies === "USER_ID") return { text: `UPDATE ${t} SET ${col} = NULL WHERE ${userIdMatch(table, field)}`, params: [ctx.userId] };
      if (field.identifies === "EMAIL") return { text: `UPDATE ${t} SET ${col} = NULL WHERE ${scope} AND ${containsEmail}`, params: [ctx.userId, pattern] };
      return { text: `UPDATE ${t} SET ${col} = NULL WHERE ${scope} AND ${col} IS NOT NULL`, params: [ctx.userId] };
    case "PSEUDONYMISE":
      return { text: `UPDATE ${t} SET ${col} = $2 WHERE ${userIdMatch(table, field)}`, params: [ctx.userId, billingPseudonym(ctx.emailHash)] };
    case "HASH":
      return { text: `UPDATE ${t} SET ${col} = $3 WHERE ${scope} AND lower(${col}) = lower($2)`, params: [ctx.userId, ctx.email, ctx.emailHash] };
    case "TOMBSTONE":
    case "REDACT": {
      const repl = field.action === "TOMBSTONE" ? ctx.tombstone : REDACTED;
      if (field.action === "TOMBSTONE" && !field.json) {
        // Whole-value replace: these columns hold exactly one address.
        return { text: `UPDATE ${t} SET ${col} = $3 WHERE ${scope} AND lower(${col}) = lower($2)`, params: [ctx.userId, ctx.email, repl] };
      }
      const replaced = `regexp_replace(${col}::text, $2, $3, 'gi')`;
      return {
        text: `UPDATE ${t} SET ${col} = ${field.json ? `${replaced}::jsonb` : replaced} WHERE ${scope} AND ${containsEmail}`,
        params: [ctx.userId, pattern, repl],
      };
    }
    case "STRIP_KEYS": {
      if (!field.path || !field.keys?.length) throw new Error(`[account-deletion] ${table}.${field.column}: STRIP_KEYS needs path and keys`);
      const p = field.path;
      return {
        text:
          `UPDATE ${t} SET ${col} = jsonb_set(${col}, '{${p}}', ` +
          `(SELECT coalesce(jsonb_agg(o - $2::text[]), '[]'::jsonb) FROM jsonb_array_elements(${col}->'${p}') o)) ` +
          `WHERE ${scope} AND jsonb_typeof(${col}->'${p}') = 'array'`,
        params: [ctx.userId, field.keys],
      };
    }
  }
}

/**
 * The check for one field: a count that must be zero. Keyed on what the field
 * IDENTIFIES, not on what the anonymiser did to it, so a wrong action shows up
 * as a failed check instead of agreeing with itself.
 */
export function anonCheck(table: string, field: AnonField, ctx: AnonContext): { text: string; params: unknown[]; describe: string } {
  assertField(table, field);
  const col = `"${field.column}"`;
  const t = `"${table}"`;
  const scope = scopeOf(table, field);
  const where = scope.startsWith("($1::text") ? "any row" : "this user's rows";
  switch (field.identifies) {
    case "USER_ID":
      return {
        text: `SELECT count(*)::int AS n FROM ${t} WHERE ${userIdMatch(table, field)}`,
        params: [ctx.userId],
        describe: `${table}.${field.column}: no row holds the user id`,
      };
    case "EMAIL":
      return {
        text: `SELECT count(*)::int AS n FROM ${t} WHERE ${scope} AND coalesce(${col}::text, '') ~* $2`,
        params: [ctx.userId, emailPattern(ctx.email, !!field.json)],
        describe: `${table}.${field.column}: the address appears in ${where} — case-insensitive, as a whole address`,
      };
    case "FREE_TEXT":
      return {
        text: `SELECT count(*)::int AS n FROM ${t} WHERE ${scope} AND ${col} IS NOT NULL`,
        params: [ctx.userId],
        describe: `${table}.${field.column}: NULL on ${where}`,
      };
    case "THIRD_PARTY":
      return {
        text:
          `SELECT count(*)::int AS n FROM ${t} WHERE ${scope} AND EXISTS (` +
          `SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${col}->'${field.path}') = 'array' THEN ${col}->'${field.path}' ELSE '[]'::jsonb END) o ` +
          `WHERE o ?| $2::text[])`,
        params: [ctx.userId, field.keys ?? []],
        describe: `${table}.${field.column}: no ${(field.keys ?? []).join(" / ")} left under "${field.path}" on ${where}`,
      };
  }
}

/** Apply every field for this kind and phase. Idempotent: a re-run matches nothing. */
export async function anonymizeTenantRows(query: Query, ctx: AnonContext, phase: "PURGE" | "COMPLETE"): Promise<Record<string, number>> {
  const changed: Record<string, number> = {};
  for (const { table, field } of anonTargets(ctx.kind, phase)) {
    const { text, params } = anonStatement(table, field, ctx);
    changed[`${table}.${field.column}`] = affected(await query(text, params));
  }
  return changed;
}

export interface VerificationCheck {
  disposition: Disposition;
  table: string;
  check: string;
  found: number;
  ok: boolean;
}

/** Run the check for every field that applies. A non-zero count is a failure. */
export async function anonymisationChecks(query: Query, ctx: AnonContext, phase: "PURGE" | "COMPLETE"): Promise<VerificationCheck[]> {
  const out: VerificationCheck[] = [];
  for (const { table, field } of anonTargets(ctx.kind, phase)) {
    const c = anonCheck(table, field, ctx);
    const found = Number((await query(c.text, c.params)).rows[0]?.n ?? 0);
    out.push({ disposition: INVENTORY[table]!.disposition, table, check: c.describe, found, ok: found === 0 });
  }
  return out;
}

/**
 * Both kinds: the member holds no current membership and sits on no current
 * reporting edge, so nobody is left reporting to someone who has gone.
 */
export async function orgClosureChecks(query: Query, email: string): Promise<VerificationCheck[]> {
  const m = await query(`SELECT count(*)::int AS n FROM org_membership WHERE lower(email) = lower($1) AND effective_until IS NULL`, [email]);
  const e = await query(
    `SELECT count(*)::int AS n FROM org_reporting_edge WHERE (lower(subordinate_email) = lower($1) OR lower(manager_email) = lower($1)) AND effective_until IS NULL`,
    [email],
  );
  const nm = Number(m.rows[0]?.n ?? 0);
  const ne = Number(e.rows[0]?.n ?? 0);
  return [
    { disposition: "RETAIN", table: "org_membership", check: "org_membership: no current membership for the address", found: nm, ok: nm === 0 },
    { disposition: "RETAIN", table: "org_reporting_edge", check: "org_reporting_edge: no current edge with the address as manager or report", found: ne, ok: ne === 0 },
  ];
}
