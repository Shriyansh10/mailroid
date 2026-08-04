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
 *
 * ESCALATION. Trusting each fresh 429's Retry-After independently has its own
 * failure mode: if Google's real block outlasts a single window, we land on
 * its boundary, get refused, believe the next window, and repeat forever —
 * seen in prod as one renewal roughly every 15 minutes for over an hour on one
 * mailbox. `quotaResumeFailures` counts consecutive failed resumptions and
 * widens the window (15 -> 30 -> 60min, capped) so we stop poking Google at an
 * interval already proven insufficient. It resets to 0 the instant ANY Gmail
 * call succeeds (markGmailHealthy) — escalation is strictly per-incident and
 * must never carry into an unrelated future one.
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

// Bumped whenever the escalation ladder below changes, and carried on every
// log line in this module. Without it, a 15/30/60 log from today is
// indistinguishable from a 15/45/90 ladder adopted six months from now.
export const COOLDOWN_POLICY_VERSION = 1;

export interface Cooldown {
  until: Date;
  reason: string;
}

/**
 * Who's asking Gmail, and about what. Threaded down from every call site so
 * cooldown logs answer "which code path" without reading source — the
 * question that cost hours to answer by hand during the incident this exists
 * to prevent a repeat of.
 */
export interface GmailCallContext {
  /** What caused the call: "ui" | "webhook" | "resume-cron" | "sync" | ... */
  trigger: string;
  /** The Gmail operation: "threads.get" | "labels.get" | "users.getProfile" | ... */
  operation?: string;
  /** threadId / historyId / messageId / labelId — whichever applies. */
  targetId?: string;
}

export type RecoveredBy = "probe-success" | "cursor-advanced" | "live-call-succeeded";

interface Decision {
  googleSuggestedMs: number;
  escalatedFloorMs: number;
  chosenMs: number;
  chosenBy: "google" | "escalation";
  why: string;
}

interface CachedRow {
  until: Date | null;
  reason: string | null;
  resumeFailures: number;
  startedAt: Date | null;
}

const memo = new Map<string, { value: CachedRow; expiresAt: number }>();

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
 * The escalation ladder, pure and DB-free so it stays directly testable.
 *
 * Doubles Google's own suggested duration once per prior consecutive failure,
 * clamped to MAX_COOLDOWN_MS, and returns whichever is LATER — Google's
 * instant or that escalated floor. Escalating off Google's stated duration
 * (rather than a hard-coded 15 min) keeps this correct if Google's advice
 * itself ever changes; the `max()` is a safety net, not decoration — it means
 * a later, more conservative Google answer is never accidentally shortened.
 *
 *   failures 0 -> Google's instant verbatim   (~15 min)
 *   failures 1 -> 2x                          (~30 min)
 *   failures 2 -> 4x, clamped                 (60 min)
 *   failures 3+ -> holds at 60 min
 */
function buildDecision(
  googleSuggested: Date,
  consecutiveFailures: number,
  now: Date,
): { until: Date; decision: Decision } {
  const failures = Math.max(0, consecutiveFailures);
  const googleMs = Math.max(0, googleSuggested.getTime() - now.getTime());
  const escalatedMs = Math.min(googleMs * 2 ** failures, MAX_COOLDOWN_MS);
  const chosenMs = Math.max(googleMs, escalatedMs);

  return {
    until: new Date(now.getTime() + chosenMs),
    decision: {
      googleSuggestedMs: googleMs,
      escalatedFloorMs: escalatedMs,
      chosenMs,
      chosenBy: chosenMs === googleMs ? "google" : "escalation",
      why:
        failures > 0
          ? `resumeFailures=${failures} -> ${2 ** failures}x Google's window, clamped to ${MAX_COOLDOWN_MS}ms`
          : "first failure this incident, Google's instant used verbatim",
    },
  };
}

export function escalatedCooldownUntil(
  googleSuggested: Date,
  consecutiveFailures: number,
  now = new Date(),
): Date {
  return buildDecision(googleSuggested, consecutiveFailures, now).until;
}

/**
 * Stable per-episode id, derived rather than stored: a hash of
 * `tenantId + startedAt`. Since startedAt is set once per cooldown episode
 * (see writes below) and cleared on recovery, this is automatically stable
 * across one episode's log lines and automatically different for the next —
 * no extra column, no lifecycle to get wrong. Not cryptographic; it only has
 * to disambiguate concurrent episodes in a log stream.
 */
function deriveIncidentId(tenantId: string, startedAt: Date): string {
  const input = `${tenantId}:${startedAt.getTime()}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

async function getCachedRow(tenantId: string): Promise<CachedRow> {
  const cached = memo.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [row] = await db
    .select({
      until: gmailTenantMappings.quotaCooldownUntil,
      reason: gmailTenantMappings.quotaCooldownReason,
      resumeFailures: gmailTenantMappings.quotaResumeFailures,
      startedAt: gmailTenantMappings.quotaCooldownStartedAt,
    })
    .from(gmailTenantMappings)
    .where(eq(gmailTenantMappings.tenantId, tenantId))
    .limit(1);

  const value: CachedRow = {
    until: row?.until ?? null,
    reason: row?.reason ?? null,
    resumeFailures: row?.resumeFailures ?? 0,
    startedAt: row?.startedAt ?? null,
  };
  memo.set(tenantId, { value, expiresAt: Date.now() + MEMO_TTL_MS });
  return value;
}

/**
 * Active cooldown for a mailbox, or null.
 *
 * An EXPIRED row reads exactly like an absent one. Nothing is required to call
 * a reset before Gmail becomes usable again — if recovery depended on a
 * cleanup step, a missed cleanup would be a permanent outage, which is the
 * bug this module exists to remove. Rows are tidied lazily on the next write.
 */
export async function getCooldown(tenantId: string): Promise<Cooldown | null> {
  const row = await getCachedRow(tenantId);
  if (row.until && row.until.getTime() > Date.now()) {
    return { until: row.until, reason: row.reason ?? "GMAIL_429" };
  }
  return null;
}

/**
 * Record/extend a cooldown and log the transition. Windows only ever EXTEND,
 * never shrink (`GREATEST` in SQL rather than read-then-write: two concurrent
 * 429s can carry different instants, and a later, shorter one must not
 * shorten a window another request already relies on). `quotaResumeFailures`
 * increments unconditionally — every call here represents one more failed
 * attempt to talk to Gmail. `quotaCooldownStartedAt` is set only when there
 * was no prior value (once per episode); an extension of an existing episode
 * leaves it untouched, which is what keeps the derived incidentId stable
 * across that episode's whole log trail.
 */
export async function setCooldown(
  tenantId: string,
  until: Date,
  ctx: GmailCallContext & { reason?: string; status?: number; decision?: Decision },
): Promise<{ resumeFailures: number; incidentId: string }> {
  const row = await getCachedRow(tenantId);
  const now = new Date();
  const wasActive = row.until !== null && row.until.getTime() > now.getTime();
  const startedAt = row.startedAt ?? now;
  const resumeFailuresAfter = row.resumeFailures + 1;
  const reason = ctx.reason ?? "GMAIL_429";

  if (row.startedAt) {
    await db
      .update(gmailTenantMappings)
      .set({
        quotaCooldownUntil: sql`GREATEST(${gmailTenantMappings.quotaCooldownUntil}, ${until.toISOString()}::timestamptz)`,
        quotaCooldownReason: reason,
        quotaResumeFailures: resumeFailuresAfter,
      })
      .where(eq(gmailTenantMappings.tenantId, tenantId));
  } else {
    await db
      .update(gmailTenantMappings)
      .set({
        quotaCooldownUntil: sql`GREATEST(${gmailTenantMappings.quotaCooldownUntil}, ${until.toISOString()}::timestamptz)`,
        quotaCooldownReason: reason,
        quotaResumeFailures: resumeFailuresAfter,
        quotaCooldownStartedAt: now,
      })
      .where(eq(gmailTenantMappings.tenantId, tenantId));
  }

  memo.delete(tenantId);

  const incidentId = deriveIncidentId(tenantId, startedAt);
  logger.warn("[GMAIL] mailbox entering quota cooldown", {
    tenantId,
    incidentId,
    policyVersion: COOLDOWN_POLICY_VERSION,
    fromState: wasActive ? "COOLDOWN" : "ACTIVE",
    toState: "COOLDOWN",
    trigger: ctx.trigger,
    operation: ctx.operation,
    targetId: ctx.targetId,
    status: ctx.status,
    resumeFailures: { before: row.resumeFailures, after: resumeFailuresAfter },
    until: until.toISOString(),
    now: now.toISOString(),
    reason,
    decision: ctx.decision,
  });

  return { resumeFailures: resumeFailuresAfter, incidentId };
}

/** Derive an escalated cooldown from a caught error and persist + log it. */
export async function recordQuotaError(
  tenantId: string,
  err: unknown,
  ctx: GmailCallContext,
): Promise<Date> {
  const now = new Date();
  const row = await getCachedRow(tenantId);
  const googleSuggested = extractRetryAfter(err) ?? defaultCooldownUntil(now);
  const { until, decision } = buildDecision(googleSuggested, row.resumeFailures, now);

  await setCooldown(tenantId, until, {
    ...ctx,
    reason: isQuotaError(err) ? "GMAIL_429" : "GMAIL_ERROR",
    status: errorStatus(err),
    decision,
  });

  return until;
}

/**
 * Reset a mailbox to healthy: clears the cooldown, zeroes the failure
 * counter, and logs the recovery. This is the ONLY reset path — call it from
 * every point that proves Gmail answered (a successful resume probe, a
 * cursor advance after a fully-ingested webhook diff, or any other
 * successful wrapped Gmail call) rather than clearing the cooldown ad hoc in
 * three places.
 *
 * WHY ANY GMAIL SUCCESS COUNTS: the counter increments on resume-probe
 * failure specifically but resets on ANY successful call. That's deliberate,
 * resting on one assumption worth stating explicitly — Gmail's rate limit is
 * per-USER (mailbox-wide), not per-endpoint, so any endpoint answering proves
 * the quota block has lifted. If Google ever introduces endpoint-specific
 * throttling this equivalence breaks.
 *
 * HOT-PATH GUARD: this runs after every successful Gmail call via
 * withGmailRetry, so it must not cost a DB write for the common case of a
 * mailbox that was never in trouble. `getCachedRow` reuses the same
 * short-TTL memo the pre-flight `assertNotCoolingDown` populated moments
 * earlier in the same call — no second query — and the write is skipped
 * entirely when there's nothing to reset.
 */
export async function markGmailHealthy(
  tenantId: string,
  ctx: GmailCallContext & { recoveredBy: RecoveredBy },
): Promise<void> {
  const row = await getCachedRow(tenantId);
  if (row.resumeFailures === 0 && !row.until && !row.startedAt) return;

  const now = new Date();
  const incidentId = deriveIncidentId(tenantId, row.startedAt ?? now);
  const blockedForMs = row.startedAt ? now.getTime() - row.startedAt.getTime() : null;
  const previousResumeFailures = row.resumeFailures;
  const previousUntil = row.until;

  try {
    await db
      .update(gmailTenantMappings)
      .set({
        quotaCooldownUntil: null,
        quotaCooldownReason: null,
        quotaResumeFailures: 0,
        quotaCooldownStartedAt: null,
      })
      .where(eq(gmailTenantMappings.tenantId, tenantId));
    memo.delete(tenantId);
  } catch (err) {
    // A healthy Gmail call must never fail because of cooldown bookkeeping,
    // and the reset is idempotent — the next success retries it and
    // self-heals — so a swallowed failure here costs nothing but a delayed
    // reset, never a stuck one.
    logger.error("[GMAIL] markGmailHealthy write failed, will retry on next success", {
      tenantId, incidentId, error: String(err),
    });
    return;
  }

  logger.info("[GMAIL] mailbox recovered", {
    tenantId,
    incidentId,
    policyVersion: COOLDOWN_POLICY_VERSION,
    fromState: "COOLDOWN",
    toState: "RECOVERED",
    trigger: ctx.trigger,
    operation: ctx.operation,
    recoveredBy: ctx.recoveredBy,
    resumeFailures: { before: previousResumeFailures, after: 0 },
    previousUntil: previousUntil?.toISOString() ?? null,
    blockedForMs,
  });
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
 * Throw instead of calling Gmail while cooling down. Also logs the skip —
 * without this, deferred work during an incident is invisible; during the
 * outage this fixes, that log stream (once added) is what shows exactly what
 * was held back and for how long.
 *
 * Deliberately throws rather than returning a boolean: a caller that forgets
 * to check a boolean silently makes the call and re-arms the window, which is
 * the failure this whole module prevents.
 */
export async function assertNotCoolingDown(
  tenantId: string,
  ctx: GmailCallContext,
): Promise<void> {
  const row = await getCachedRow(tenantId);
  const now = Date.now();
  if (!row.until || row.until.getTime() <= now) return;

  const incidentId = deriveIncidentId(tenantId, row.startedAt ?? row.until);
  logger.info("[GMAIL] call skipped, mailbox cooling down", {
    tenantId,
    incidentId,
    policyVersion: COOLDOWN_POLICY_VERSION,
    fromState: "COOLDOWN",
    toState: "COOLDOWN",
    trigger: ctx.trigger,
    operation: ctx.operation,
    targetId: ctx.targetId,
    cooldownUntil: row.until.toISOString(),
    reason: row.reason,
    remainingMs: row.until.getTime() - now,
    blockedForMs: row.startedAt ? now - row.startedAt.getTime() : null,
  });

  throw new GmailQuotaCooldownError(tenantId, row.until, ctx.operation ?? ctx.trigger);
}

/** Test seam only — the memo is process-global and would leak between cases. */
export function __resetCooldownMemo(): void {
  memo.clear();
}
