import { db, eq, or } from "@repo/database";
import { syncPauses } from "@repo/database/models/sync-pauses";
import { logger } from "@repo/logger";

/**
 * Operator kill switch — see packages/database/models/sync-pauses.ts for why
 * the table is shaped the way it is.
 *
 * THE READ PATH NEVER WRITES. An expired row reads exactly like an absent one:
 * resolvePause() filters it out in memory and reports "not paused". It does not
 * delete it. Two reasons, both learned the hard way in quota-cooldown.ts:
 *
 *   1. This runs before every Gmail call. A read that can write turns the hot
 *      path into a DB writer, with lock contention and failure modes a read has
 *      no business having.
 *   2. Recovery must never DEPEND on cleanup. If lifting a pause required a
 *      successful DELETE, one failed cleanup would be a permanent outage —
 *      exactly the bug the cooldown module was rewritten to remove.
 *
 * Expired rows are tidied by the daily reconciliation cron, purely cosmetically.
 * resolvePause being pure enforces all of this structurally: it has no database
 * handle and cannot write even by accident.
 */

export type PauseMode = "sync" | "disabled" | "maintenance";
export type PauseScope = "global" | "tenant";

/** Most restrictive first — the order IS the precedence. */
const MODE_SEVERITY: Record<PauseMode, number> = {
  maintenance: 3,
  disabled: 2,
  sync: 1,
};

export interface PauseRow {
  scope: string;
  tenantId: string | null;
  mode: string;
  reason: string | null;
  createdBy: string | null;
  blockWatchRenewal: boolean;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface ActivePause {
  scope: PauseScope;
  mode: PauseMode;
  reason: string | null;
  createdBy: string | null;
  blockWatchRenewal: boolean;
  expiresAt: Date | null;
  createdAt: Date;
}

// getPause runs before every Gmail call and the overwhelmingly common answer is
// "not paused". Same 5s TTL as quota-cooldown.ts: long enough to collapse a
// burst, short enough that flipping the switch by hand takes effect while you
// are still looking at the terminal. Negative results are cached too — that is
// the hot path.
const MEMO_TTL_MS = 5_000;

const memo = new Map<string, { value: ActivePause | null; expiresAt: number }>();
/** Last state we LOGGED per key, so transitions are reported once, not per call. */
const lastLogged = new Map<string, string>();

/** Thrown instead of calling Google while paused. Mirrors GmailQuotaCooldownError. */
export class SyncPausedError extends Error {
  readonly status = 503;
  readonly paused = true;
  readonly mode: PauseMode;
  readonly retryAfter: Date | null;

  constructor(tenantId: string, pause: ActivePause, operation?: string) {
    super(
      `Sync paused (${pause.mode}, scope=${pause.scope}) for tenant ${tenantId}` +
        (pause.expiresAt ? ` until ${pause.expiresAt.toISOString()}` : " until cleared") +
        (operation ? ` (skipped: ${operation})` : ""),
    );
    this.name = "SyncPausedError";
    this.mode = pause.mode;
    this.retryAfter = pause.expiresAt;
  }
}

function isExpired(row: { expiresAt: Date | null }, now: Date): boolean {
  return row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
}

/**
 * Pick the effective pause for a tenant from the candidate rows.
 *
 * PURE — takes rows, returns a verdict, touches nothing. If this ever needs a
 * database handle to be testable, the read-path rule above has been broken.
 *
 * A global row applies to every tenant. When both a global and a tenant row are
 * active, the more restrictive mode wins: a mailbox individually paused for
 * `sync` during whole-app `maintenance` is still under maintenance.
 */
export function resolvePause(
  rows: PauseRow[],
  tenantId: string | null,
  now = new Date(),
): ActivePause | null {
  let best: ActivePause | null = null;

  for (const row of rows) {
    if (isExpired(row, now)) continue;

    const applies =
      row.scope === "global" || (tenantId !== null && row.tenantId === tenantId);
    if (!applies) continue;

    const mode = row.mode as PauseMode;
    if (!(mode in MODE_SEVERITY)) continue; // unknown mode: ignore, don't guess

    if (best === null || MODE_SEVERITY[mode] > MODE_SEVERITY[best.mode]) {
      best = {
        scope: row.scope as PauseScope,
        mode,
        reason: row.reason,
        createdBy: row.createdBy,
        blockWatchRenewal: row.blockWatchRenewal,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      };
    }
  }

  return best;
}

/**
 * Logs only when the observed state CHANGES, so an incident produces a handful
 * of lines rather than one per Gmail call.
 *
 * Note these are transitions we OBSERVE, not ones we cause: pauses are created
 * by raw SQL, so no application code runs at INSERT time and there is nothing to
 * hook. `created_by` on the row carries the intent that this log cannot.
 */
function logTransition(key: string, next: ActivePause | null): void {
  const signature = next
    ? `${next.scope}:${next.mode}:${next.expiresAt?.toISOString() ?? "never"}`
    : "none";
  if (lastLogged.get(key) === signature) return;

  const previous = lastLogged.get(key);
  lastLogged.set(key, signature);
  if (previous === undefined && next === null) return; // first look, nothing to say

  if (next) {
    logger.warn("[PAUSE] sync paused", {
      tenantId: key,
      fromState: previous === undefined || previous === "none" ? "ACTIVE" : "PAUSED",
      toState: "PAUSED",
      scope: next.scope,
      mode: next.mode,
      reason: next.reason,
      createdBy: next.createdBy,
      blockWatchRenewal: next.blockWatchRenewal,
      expiresAt: next.expiresAt?.toISOString() ?? null,
    });
  } else {
    logger.info("[PAUSE] sync resumed", {
      tenantId: key,
      fromState: "PAUSED",
      toState: "ACTIVE",
      previous,
    });
  }
}

/** Active pause for a tenant (or the global one), or null. */
export async function getPause(tenantId: string | null): Promise<ActivePause | null> {
  const key = tenantId ?? "__global_only__";
  const cached = memo.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    // Re-check expiry: a memoised pause can lapse inside the TTL.
    if (!cached.value || !isExpired(cached.value, new Date())) return cached.value;
    return null;
  }

  const rows = await db
    .select()
    .from(syncPauses)
    .where(
      tenantId === null
        ? eq(syncPauses.scope, "global")
        : or(eq(syncPauses.scope, "global"), eq(syncPauses.tenantId, tenantId)),
    );

  const value = resolvePause(rows as PauseRow[], tenantId);
  memo.set(key, { value, expiresAt: Date.now() + MEMO_TTL_MS });
  logTransition(key, value);
  return value;
}

/** Is the whole app under maintenance? Cheap enough to call per request. */
export async function getGlobalMaintenance(): Promise<ActivePause | null> {
  const pause = await getPause(null);
  return pause?.mode === "maintenance" ? pause : null;
}

/**
 * Throw instead of calling Google while paused.
 *
 * Throws rather than returning a boolean for the same reason as
 * assertNotCoolingDown: a caller who forgets to check a boolean silently makes
 * the call, which is the entire failure this prevents.
 */
export async function assertNotPaused(
  tenantId: string,
  ctx: { trigger: string; operation?: string; targetId?: string },
): Promise<void> {
  const pause = await getPause(tenantId);
  if (!pause) return;

  logger.info("[PAUSE] call skipped, sync paused", {
    tenantId,
    trigger: ctx.trigger,
    operation: ctx.operation,
    targetId: ctx.targetId,
    scope: pause.scope,
    mode: pause.mode,
    reason: `PAUSED_${pause.mode}`,
    expiresAt: pause.expiresAt?.toISOString() ?? null,
  });

  throw new SyncPausedError(tenantId, pause, ctx.operation ?? ctx.trigger);
}

/**
 * Tenant ids with an active pause, for cron selection queries.
 *
 * Two narrowing options, because "paused" does not mean the same thing to every
 * caller:
 *
 * - `forWatchRenewal` — only pauses that block users.watch. An ordinary pause
 *   deliberately lets the watch keep renewing: the subscription is not a mailbox
 *   read, and dropping it costs a re-registration for no benefit (see
 *   block_watch_renewal on the model).
 * - `blockingLocalWork` — only `disabled`/`maintenance`. A `sync` pause is about
 *   not talking to Google; blocking LLM classification or embeddings over
 *   already-stored rows would buy nothing. A deactivated account is different —
 *   there we do not want to spend tokens on them at all.
 */
export async function getPausedTenantIds(
  opts: { forWatchRenewal?: boolean; blockingLocalWork?: boolean } = {},
): Promise<Set<string>> {
  const rows = await db.select().from(syncPauses);
  const now = new Date();
  const paused = new Set<string>();

  const qualifies = (row: (typeof rows)[number]): boolean => {
    if (isExpired(row, now)) return false;
    if (opts.forWatchRenewal && !row.blockWatchRenewal) return false;
    if (opts.blockingLocalWork && row.mode === "sync") return false;
    return true;
  };

  let globalActive = false;
  for (const row of rows) {
    if (!qualifies(row)) continue;
    if (row.scope === "global") globalActive = true;
    if (row.tenantId) paused.add(row.tenantId);
  }

  // A global pause covers every tenant; callers treat this sentinel as
  // "everything" so they can short-circuit without enumerating tenants.
  if (globalActive) paused.add("*");
  return paused;
}

/** True when this tenant is covered by `paused` (honouring the "*" sentinel). */
export function isTenantPaused(paused: Set<string>, tenantId: string): boolean {
  return paused.has("*") || paused.has(tenantId);
}

/** Deletes expired rows. Cosmetic only — an expired row is already inert. */
export async function deleteExpiredPauses(): Promise<number> {
  const rows = await db.select().from(syncPauses);
  const now = new Date();
  const stale = rows.filter((r) => isExpired(r, now));
  for (const row of stale) {
    await db.delete(syncPauses).where(eq(syncPauses.id, row.id));
  }
  if (stale.length > 0) {
    logger.info("[PAUSE] cleaned up expired pauses", { count: stale.length });
  }
  return stale.length;
}

/** Test seam only — the memo is process-global and would leak between cases. */
export function __resetPauseMemo(): void {
  memo.clear();
  lastLogged.clear();
}
