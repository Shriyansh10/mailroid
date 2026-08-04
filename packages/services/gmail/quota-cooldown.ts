import { db, eq, sql } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { logger } from "@repo/logger";

/**
 * Per-mailbox Gmail quota cooldown.
 *
 * Gmail's per-user 429 is not a token bucket that refills on its own schedule —
 * it answers with an absolute instant ("Retry after 2026-08-04T03:58:23.313Z")
 * and every request made *before* that instant pushes it FURTHER OUT. Observed
 * in production: 03:58:23 → 03:58:33 → 03:58:43, one bump per retry, for seven
 * hours. A mailbox in that state cannot recover while anything keeps calling
 * Google, because the retries are what hold the window open.
 *
 * So the cooldown is stored, not inferred: once we know the instant, every
 * caller skips Gmail entirely until it passes. That is the whole mechanism —
 * the fix is the calls we DON'T make.
 */

// Gmail hands back an absolute instant, so the window is normally exact. These
// only bound the damage when it is absent or implausible.
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;
// Our clock and Google's differ by some unknown amount; resuming a beat late
// costs one delayed sync, resuming a beat early costs another pushed window.
const CLOCK_SKEW_PAD_MS = 5_000;

// getCooldown runs before *every* Gmail call, and the overwhelmingly common
// answer is "no cooldown" — without this that becomes a DB round trip per API
// call. Short enough that another container's write is picked up quickly, long
// enough to collapse a burst. Negative results are cached too: that is the hot
// path, and the cost of being 5s stale is one call we'd have made anyway.
const MEMO_TTL_MS = 5_000;

export interface Cooldown {
  until: Date;
  reason: string;
}

const memo = new Map<string, { value: Cooldown | null; expiresAt: number }>();

/** Thrown instead of calling Gmail while a mailbox is cooling down. */
export class GmailQuotaCooldownError extends Error {
  readonly status = 429;
  readonly cooldown = true;
  readonly retryAfter: Date;

  constructor(tenantId: string, until: Date, label?: string) {
    super(
      `Gmail quota cooldown for tenant ${tenantId} until ${until.toISOString()}` +
        (label ? ` (skipped: ${label})` : ""),
    );
    this.name = "GmailQuotaCooldownError";
    this.retryAfter = until;
  }
}

function errorBodyMessage(err: unknown): string {
  const body = (err as { body?: { error?: { message?: unknown } } } | null)?.body;
  const message = body?.error?.message;
  return typeof message === "string" ? message : "";
}

function errorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/**
 * Is this a Gmail rate-limit rejection?
 *
 * Structured fields first — `status` and `body.error.status` are contract,
 * message wording is not. The string fallback exists for one specific caller:
 * the raw `fetch` in webhook-sync.ts historically threw
 * `new Error("Gmail history fetch failed: 429 - …")`, flattening the status
 * into prose. That path now attaches `status` properly, but the fallback stays
 * cheap insurance — it is the exact path the production deadlock ran through,
 * and misclassifying it means not cooling down at all.
 */
export function isQuotaError(err: unknown): boolean {
  if (errorStatus(err) === 429) return true;

  const bodyStatus = (err as { body?: { error?: { status?: unknown } } } | null)
    ?.body?.error?.status;
  if (bodyStatus === "RESOURCE_EXHAUSTED") return true;

  const text = `${errorBodyMessage(err)} ${String(
    (err as { message?: unknown } | null)?.message ?? err ?? "",
  )}`;
  return /\b429\b|rate ?limit ?exceeded|user-rate limit|RESOURCE_EXHAUSTED/i.test(text);
}

/**
 * Should a read fall back to the locally stored copy rather than fail?
 *
 * Quota, 5xx and transport failures mean "Gmail is unreachable right now" —
 * the cached copy is the best available answer. 401/403/404 deliberately do
 * NOT qualify: a revoked token or a deleted thread is a real, actionable error,
 * and papering over it with stale content would hide exactly the kind of drift
 * the user needs told about.
 */
export function isGmailUnavailable(err: unknown): boolean {
  if (isQuotaError(err)) return true;
  const status = errorStatus(err);
  if (typeof status === "number") return status >= 500;
  // No status at all: transport/DNS/timeout, i.e. we never reached Google.
  return true;
}

/**
 * Pull the retry instant out of a Gmail 429.
 *
 * THE ONE FRAGILE PIECE, deliberately quarantined here. Google puts the
 * timestamp in prose ("… Retry after 2026-08-04T03:58:23.313Z") and does not
 * reliably send a usable Retry-After header, so this has to pattern-match. If
 * the wording ever changes this returns null and callers fall back to
 * DEFAULT_COOLDOWN_MS — a parser break costs cooldown *precision*, never
 * *correctness*. Nothing about detection or safety depends on it.
 */
export function extractRetryAfter(err: unknown, now = new Date()): Date | null {
  const text = `${errorBodyMessage(err)} ${String(
    (err as { message?: unknown } | null)?.message ?? "",
  )}`;

  const iso = text.match(
    /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
  );
  let until: Date | null = null;

  if (iso?.[1]) {
    const parsed = new Date(iso[1].replace(" ", "T"));
    if (!Number.isNaN(parsed.getTime())) until = parsed;
  }

  // Some Google surfaces (and most HTTP intermediaries) use delta-seconds.
  if (!until) {
    const header = (err as { headers?: { get?: (n: string) => string | null } } | null)
      ?.headers?.get?.("retry-after");
    const seconds = header ? Number(header) : NaN;
    if (Number.isFinite(seconds) && seconds > 0) {
      until = new Date(now.getTime() + seconds * 1000);
    }
  }

  if (!until) return null;

  // A window already in the past tells us nothing — treat as unparseable and
  // let the caller apply its default rather than "cooling down" until a moment
  // that has already been and gone.
  const padded = new Date(until.getTime() + CLOCK_SKEW_PAD_MS);
  if (padded.getTime() <= now.getTime()) return null;

  // Cap it: a malformed year-3000 timestamp must not park a mailbox forever.
  const max = new Date(now.getTime() + MAX_COOLDOWN_MS);
  return padded.getTime() > max.getTime() ? max : padded;
}

/** The window to use when Google didn't give us a usable one. */
export function defaultCooldownUntil(now = new Date()): Date {
  return new Date(now.getTime() + DEFAULT_COOLDOWN_MS);
}

/**
 * Active cooldown for a mailbox, or null.
 *
 * An EXPIRED row reads exactly like an absent one. Nothing is required to call
 * clearCooldown() before Gmail becomes usable again — if recovery depended on
 * a cleanup step, a missed cleanup would be a permanent outage, which is the
 * bug this module exists to remove. Rows are tidied lazily on the next write.
 */
export async function getCooldown(tenantId: string): Promise<Cooldown | null> {
  const cached = memo.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    // Re-check expiry: a memoised window can lapse inside the TTL.
    if (!cached.value || cached.value.until.getTime() > Date.now()) return cached.value;
    return null;
  }

  const [row] = await db
    .select({
      until: gmailTenantMappings.quotaCooldownUntil,
      reason: gmailTenantMappings.quotaCooldownReason,
    })
    .from(gmailTenantMappings)
    .where(eq(gmailTenantMappings.tenantId, tenantId))
    .limit(1);

  const value: Cooldown | null =
    row?.until && row.until.getTime() > Date.now()
      ? { until: row.until, reason: row.reason ?? "GMAIL_429" }
      : null;

  memo.set(tenantId, { value, expiresAt: Date.now() + MEMO_TTL_MS });
  return value;
}

/**
 * Record a cooldown. Windows only ever EXTEND, never shrink.
 *
 * `GREATEST` in SQL rather than read-then-write: two concurrent 429s can carry
 * different instants (Google's answer varies with how conservative it feels),
 * and a later, shorter one must not shorten a window another request is already
 * relying on. Postgres GREATEST ignores NULLs, so the first write just lands.
 */
export async function setCooldown(
  tenantId: string,
  until: Date,
  reason = "GMAIL_429",
): Promise<void> {
  await db
    .update(gmailTenantMappings)
    .set({
      quotaCooldownUntil: sql`GREATEST(${gmailTenantMappings.quotaCooldownUntil}, ${until.toISOString()}::timestamptz)`,
      quotaCooldownReason: reason,
    })
    .where(eq(gmailTenantMappings.tenantId, tenantId));

  memo.delete(tenantId);
  logger.warn("[GMAIL] mailbox entering quota cooldown", {
    tenantId,
    until: until.toISOString(),
    now: new Date().toISOString(),
    reason,
  });
}

/** Derive and persist a cooldown straight from a caught error. */
export async function recordQuotaError(tenantId: string, err: unknown): Promise<Date> {
  const until = extractRetryAfter(err) ?? defaultCooldownUntil();
  await setCooldown(tenantId, until);
  return until;
}

export async function clearCooldown(tenantId: string): Promise<void> {
  await db
    .update(gmailTenantMappings)
    .set({ quotaCooldownUntil: null, quotaCooldownReason: null })
    .where(eq(gmailTenantMappings.tenantId, tenantId));
  memo.delete(tenantId);
}

/**
 * Durable webhook health, the counterpart to acking 200 on failure.
 *
 * /api/webhook answers 200 even when processing failed, because a non-2xx
 * makes Pub/Sub redeliver every ~15s for 7 days — amplifying a fault instead
 * of repairing it. That removes the 500 that used to announce a broken
 * mailbox, so the signal has to survive somewhere queryable; an error log is
 * the only other trace and logs rotate.
 */
export async function recordWebhookFailure(tenantId: string, reason: string): Promise<void> {
  await db
    .update(gmailTenantMappings)
    .set({
      lastWebhookFailureAt: new Date(),
      lastWebhookFailureReason: reason.slice(0, 500),
    })
    .where(eq(gmailTenantMappings.tenantId, tenantId));
}

export async function clearWebhookFailure(tenantId: string): Promise<void> {
  await db
    .update(gmailTenantMappings)
    .set({ lastWebhookFailureAt: null, lastWebhookFailureReason: null })
    .where(eq(gmailTenantMappings.tenantId, tenantId));
}

/**
 * Throw instead of calling Gmail while cooling down.
 *
 * Deliberately throws rather than returning a boolean: a caller that forgets to
 * check a boolean silently makes the call and re-arms the window, which is the
 * failure this whole module prevents.
 */
export async function assertNotCoolingDown(tenantId: string, label?: string): Promise<void> {
  const active = await getCooldown(tenantId);
  if (active) throw new GmailQuotaCooldownError(tenantId, active.until, label);
}

/** Test seam only — the memo is process-global and would leak between cases. */
export function __resetCooldownMemo(): void {
  memo.clear();
}
