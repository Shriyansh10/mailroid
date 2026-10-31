/**
 * The writer drain: wait out every write that was already in progress when the
 * fence committed.
 *
 * WHY. The fence trigger checks `tenant_epoch` when a row is written. A
 * transaction that wrote a row BEFORE the fence committed, and is still open,
 * already passed that check. Its row is invisible to the purge and to the
 * verification count until it commits — so without this, a deletion could be
 * marked COMPLETED and the row appear afterwards
 * (service.postgres.test.ts proves both the failure and the fix).
 *
 * HOW. For each fenced table, one at a time, in a fixed order: open a
 * transaction, take `LOCK TABLE … IN SHARE MODE`, commit. SHARE conflicts with
 * the ROW EXCLUSIVE lock every INSERT/UPDATE holds until its transaction ends,
 * and a writer takes that lock when its statement starts — before the trigger
 * runs. So the lock is granted only once every transaction that was writing
 * the table has committed or rolled back. Once all tables are drained, every
 * pre-fence write has landed (and will be purged) or is gone, and every later
 * write meets the trigger, which rejects it.
 *
 * COST. While a SHARE request waits, new writers to that table queue behind it.
 * The wait normally lasts milliseconds; it is capped by `lock_timeout`. One
 * table per transaction means the drain never holds one lock while waiting
 * for another, so it can't take part in a lock cycle with a writer.
 *
 * FAILURE. The first table that times out, deadlocks or loses its connection
 * stops the drain and is reported with the Postgres error code. The drain is
 * idempotent: a retry simply drains every table again.
 */

import type { PoolClient } from "pg";

export type DrainResult =
  | { ok: true; tables: number; slow: Record<string, number> }
  | { ok: false; table: string; code: string | null; reason: string; drained: string[] };

const IDENT = /^[a-z_]+$/;

/** Waits above this are reported, so a drain that nearly timed out is visible. */
const SLOW_MS = 250;

export async function drainWriters(
  connect: () => Promise<PoolClient>,
  tables: readonly string[],
  lockTimeoutMs: number,
): Promise<DrainResult> {
  const ordered = [...tables].sort();
  for (const t of ordered) if (!IDENT.test(t)) throw new Error(`[account-deletion] bad table name ${t}`);
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) throw new Error(`[account-deletion] bad lock timeout ${lockTimeoutMs}`);

  const drained: string[] = [];
  const slow: Record<string, number> = {};
  for (const table of ordered) {
    let client: PoolClient;
    try {
      client = await connect();
    } catch (err) {
      return { ok: false, table, code: pgCode(err), reason: `could not get a connection: ${errText(err)}`, drained };
    }
    const started = Date.now();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      await client.query(`LOCK TABLE "${table}" IN SHARE MODE`);
      await client.query("COMMIT");
      client.release();
    } catch (err) {
      // A connection that can't roll back is not returned to the pool.
      let broken: unknown = null;
      await client.query("ROLLBACK").catch((e: unknown) => (broken = e));
      client.release(broken ? (broken as Error) : undefined);
      return { ok: false, table, code: pgCode(err), reason: describe(err, table, lockTimeoutMs), drained };
    }
    const waited = Date.now() - started;
    if (waited > SLOW_MS) slow[table] = waited;
    drained.push(table);
  }
  return { ok: true, tables: drained.length, slow };
}

function pgCode(err: unknown): string | null {
  return (err as { code?: unknown })?.code && typeof (err as { code: unknown }).code === "string" ? (err as { code: string }).code : null;
}

function describe(err: unknown, table: string, timeoutMs: number): string {
  switch (pgCode(err)) {
    case "55P03":
      return `a transaction kept writing "${table}" for longer than ${timeoutMs} ms (lock_timeout); it may hold a write admitted before the fence`;
    case "40P01":
      return `deadlock while draining "${table}": ${errText(err)}`;
    default:
      return `draining "${table}" failed: ${errText(err)}`;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
