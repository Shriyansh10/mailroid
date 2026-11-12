import { pool } from "@repo/database";
import { logger } from "@repo/logger";

const IDENT_RE = /^[a-z_]+$/;

/**
 * Refresh Postgres's planner statistics for these tables, right after a bulk
 * write has changed who owns how many rows.
 *
 * Autovacuum only re-analyzes a table after 50 + 10% of its rows change. On
 * message_metadata (~150k rows) that is ~15k, so a new account importing 11.7k
 * messages never crosses it: the stats still say the user owns ~1 row, and the
 * inbox list plans a nested loop on threadHasMessage's OR condition that
 * rescans every one of the user's messages per thread. On 2026-11-12 that took
 * single list queries to 3–5 minutes and pinned the 1-vCPU box. ANALYZE
 * samples a fixed 30k rows, so it costs about a second at any table size.
 *
 * Best-effort on purpose: stale stats make queries slow, not wrong, so a
 * failure here is logged in full and never fails the sync or deletion that
 * called it.
 */
export async function refreshPlannerStats(tables: string[], context: Record<string, unknown>): Promise<void> {
  for (const table of tables) {
    if (!IDENT_RE.test(table)) {
      logger.error("[DB] refreshPlannerStats refused a bad identifier", { ...context, table });
      continue;
    }
    const started = Date.now();
    try {
      await pool.query(`ANALYZE "${table}"`);
      logger.info("[DB] planner stats refreshed", { ...context, table, ms: Date.now() - started });
    } catch (err) {
      logger.error("[DB] planner stats refresh failed", {
        ...context, table, ms: Date.now() - started, error: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
}
