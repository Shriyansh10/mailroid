/**
 * userId | email → tenant id.
 *
 * Both of the scripts this package absorbed carried their own near-identical
 * copy of this, differing only in which mapping table they queried. That's the
 * only thing that actually varies, so it's the parameter.
 */

import { db, sql } from "@repo/database";

/**
 * Which connected-account table to resolve an email through. A user can have
 * Gmail connected but not Calendar (or vice versa), so the caller has to say
 * which integration it needs — resolving through the wrong one silently fails
 * for users who only connected the other.
 */
export type MappingTable = "gmail" | "calendar";

const TABLES: Record<MappingTable, string> = {
  gmail: "gmail_tenant_mappings",
  calendar: "calendar_tenant_mappings",
};

/**
 * Returns the tenant id, or null when an email matches no connected account.
 *
 * A non-email argument is passed through untouched: it's already a tenant id.
 * This means a typo'd id fails later, at the point of use, rather than here —
 * deliberately, since there is no single table that can prove an arbitrary
 * tenant id exists.
 */
export async function resolveUserId(
  arg: string,
  table: MappingTable,
): Promise<string | null> {
  if (!arg.includes("@")) return arg;

  // sql.raw for the table name: it comes from the TABLES map above, never from
  // user input, and an identifier can't be a bind parameter.
  const rows = await db.execute(
    sql`SELECT tenant_id FROM ${sql.raw(TABLES[table])} WHERE email_address = ${arg} LIMIT 1`,
  );

  // db.execute's return shape differs between drivers (a {rows} envelope vs a
  // bare array), and this runs against whichever one the env points at.
  const row =
    (rows as unknown as { rows?: Array<{ tenant_id: string }> }).rows?.[0] ??
    (Array.isArray(rows) ? (rows[0] as { tenant_id?: string }) : undefined);

  return row?.tenant_id ?? null;
}
