import { and, db, eq, lte, sql } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { logger } from "@repo/logger";

import { assertNotPaused } from "./pause.ts";
import {
  GmailAuthError,
  MAX_COOLDOWN_MS,
  classifyGmailFailure,
  extractRetryAfter,
} from "./gmail-errors.ts";
import type { GmailCallContext } from "./gmail-errors.ts";
import { WEBHOOK_IN_FLIGHT } from "./webhook-push.ts";

// Classification is pure and lives in gmail-errors.ts so that gmail-request.ts
// can use it without importing this module's gates. Re-exported so existing
// importers are unaffected by the move.
export {
  classifyGmailFailure,
  extractRetryAfter,
  isGmailUnavailable,
  isQuotaError,
} from "./gmail-errors.ts";
export { GmailAuthError };
export type { GmailCallContext, GmailFailureKind } from "./gmail-errors.ts";

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
 *
 * ONLY QUOTA FAILURES BELONG ON THAT LADDER. A 401 is an authentication
 * problem, and escalating it produces a cooldown that blocks the very refresh
 * which would fix it — a permanent outage dressed up as backoff. Not
 * hypothetical: it ran in production from 2026-08-25, once an hour, until the
 * ladder was made unreachable except through handleGmailFailure. Auth failures
 * take recordAuthFailure instead and never touch quotaResumeFailures.
 */

// Gmail hands back an absolute instant, so the window is normally exact. This
// only bounds the damage when it is absent or implausible. MAX_COOLDOWN_MS
// lives in gmail-errors.ts — the retry-after parser clamps to the same ceiling
// and two copies would silently diverge.
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

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

// GmailCallContext moved to gmail-errors.ts (gate-free) so gmail-request.ts can
// use it without importing this module. Re-exported at the top of this file, so
// every existing importer is unaffected.

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
  authFailedAt: Date | null;
  authFailureReason: string | null;
}

const memo = new Map<string, { value: CachedRow; expiresAt: number }>();

/** Numeric status off a corsair ApiError or a plain fetch-derived error. */
function errorStatusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

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
      authFailedAt: gmailTenantMappings.gmailAuthFailedAt,
      authFailureReason: gmailTenantMappings.gmailAuthFailureReason,
    })
    .from(gmailTenantMappings)
    .where(eq(gmailTenantMappings.tenantId, tenantId))
    .limit(1);

  const value: CachedRow = {
    until: row?.until ?? null,
    reason: row?.reason ?? null,
    resumeFailures: row?.resumeFailures ?? 0,
    startedAt: row?.startedAt ?? null,
    authFailedAt: row?.authFailedAt ?? null,
    authFailureReason: row?.authFailureReason ?? null,
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
 * Auth-failed state for a mailbox, or null. The non-throwing counterpart to
 * assertAuthHealthy, for callers that want to *filter* rather than fail — the
 * resume cron sweeps many mailboxes and one dead mailbox must not abort the run.
 */
export async function getAuthFailure(
  tenantId: string,
): Promise<{ at: Date; reason: string | null } | null> {
  const row = await getCachedRow(tenantId);
  return row.authFailedAt ? { at: row.authFailedAt, reason: row.authFailureReason } : null;
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

/**
 * Derive an escalated cooldown from a caught error and persist + log it.
 *
 * DELIBERATELY NOT EXPORTED. This is the escalation ladder's only door, and
 * every caller must arrive through handleGmailFailure so classification
 * happens exactly once, in one place. The previous public export is what let
 * cooldown-resume-cron.ts hand it a 401 — which escalated an authentication
 * problem into a quota window that then blocked the refresh that would have
 * fixed it. Making this private is the structural fix; the comment is only the
 * reminder.
 */
async function recordQuotaError(
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
    reason: "GMAIL_429",
    status: errorStatusOf(err),
    decision,
  });

  return until;
}

/**
 * Record that authentication is dead for this mailbox.
 *
 * Reached only after corsair has actually attempted a refresh and failed, so a
 * written value means "the credentials cannot be recovered", never "we did not
 * try". Note what this does NOT do: no cooldown window, no `quotaResumeFailures`
 * increment, nothing on the escalation ladder. Retrying a revoked grant every
 * hour does not un-revoke it; it just generates noise and hides the real state.
 */
export async function recordAuthFailure(
  tenantId: string,
  err: unknown,
  ctx: GmailCallContext,
): Promise<void> {
  const now = new Date();
  const row = await getCachedRow(tenantId);
  const status = errorStatusOf(err);
  const reason = String(
    (err as { message?: unknown } | null)?.message ?? err ?? "unknown",
  ).slice(0, 500);

  await db
    .update(gmailTenantMappings)
    .set({ gmailAuthFailedAt: now, gmailAuthFailureReason: reason })
    .where(eq(gmailTenantMappings.tenantId, tenantId));
  memo.delete(tenantId);

  logger.warn("[GMAIL] mailbox authentication failed", {
    tenantId,
    incidentId: deriveIncidentId(tenantId, row.authFailedAt ?? now),
    policyVersion: COOLDOWN_POLICY_VERSION,
    fromState: row.authFailedAt ? "AUTH_FAILED" : "ACTIVE",
    toState: "AUTH_FAILED",
    trigger: ctx.trigger,
    operation: ctx.operation,
    targetId: ctx.targetId,
    status,
    reason,
    now: now.toISOString(),
  });
}

/**
 * THE ONLY PUBLIC ENTRY POINT for a failed Gmail call.
 *
 * Classification happens here and nowhere else. The three families are handled
 * by three different mechanisms, and routing one into another's mechanism is
 * the bug class this function exists to make unreachable:
 *
 *   quota (429) → escalating cooldown, Google's Retry-After respected
 *   auth  (401) → auth-failed state; NO cooldown, NO escalation counter
 *   other       → logged; no state written, because we do not know what to write
 *
 * "other" deliberately writes nothing. A 404, a 500 or a socket hang-up is not
 * evidence about either quota or credentials, and inventing a state for it is
 * how a transient blip becomes a parked mailbox.
 */
export async function handleGmailFailure(
  tenantId: string,
  err: unknown,
  ctx: GmailCallContext,
): Promise<void> {
  switch (classifyGmailFailure(err)) {
    case "quota":
      await recordQuotaError(tenantId, err, ctx);
      return;
    case "auth":
      await recordAuthFailure(tenantId, err, ctx);
      return;
    default:
      logger.warn("[GMAIL] call failed, neither quota nor auth", {
        tenantId,
        trigger: ctx.trigger,
        operation: ctx.operation,
        targetId: ctx.targetId,
        status: errorStatusOf(err),
        error: String((err as { message?: unknown } | null)?.message ?? err),
      });
  }
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
  // Auth state is cleared here too, so it has to be part of the "nothing to do"
  // test — otherwise a mailbox that recovered its credentials would keep a
  // stale gmail_auth_failed_at and stay gated forever.
  if (
    row.resumeFailures === 0 &&
    !row.until &&
    !row.startedAt &&
    !row.authFailedAt
  ) {
    return;
  }

  const now = new Date();
  const incidentId = deriveIncidentId(tenantId, row.startedAt ?? now);
  const blockedForMs = row.startedAt ? now.getTime() - row.startedAt.getTime() : null;
  const previousResumeFailures = row.resumeFailures;
  const previousUntil = row.until;
  const previousAuthFailedAt = row.authFailedAt;

  try {
    await db
      .update(gmailTenantMappings)
      .set({
        quotaCooldownUntil: null,
        quotaCooldownReason: null,
        quotaResumeFailures: 0,
        quotaCooldownStartedAt: null,
        // A successful Gmail call proves the credentials work, which is the
        // only evidence that could clear this. Same "any success resets
        // everything" contract as the quota fields.
        gmailAuthFailedAt: null,
        gmailAuthFailureReason: null,
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
    previousAuthFailedAt: previousAuthFailedAt?.toISOString() ?? null,
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

/**
 * Durable "this delivery is not yet processed" marker, written BEFORE a push is
 * acked. Returns the exact instant written, which the caller threads through to
 * clearWebhookMarker. See WEBHOOK_IN_FLIGHT in webhook-push.ts.
 *
 * Throws if the write fails — the caller must then NACK, because without the
 * marker an acked delivery whose sync later fails would leave nothing behind
 * for the resume cron to find.
 */
export async function markWebhookInFlight(tenantId: string): Promise<Date> {
  const at = new Date();
  await db
    .update(gmailTenantMappings)
    .set({ lastWebhookFailureAt: at, lastWebhookFailureReason: WEBHOOK_IN_FLIGHT })
    .where(eq(gmailTenantMappings.tenantId, tenantId));
  return at;
}

/**
 * Clear the marker after a sync COMPLETED — but only if nothing newer was
 * written since `markerAt`.
 *
 * The `<=` is the whole point. Deliveries for one mailbox overlap: A writes its
 * marker, B writes a later one, A's sync finishes. An unconditional clear here
 * would erase B's guarantee while B is still queued; if B then crashed, nothing
 * would remain to say it never ran. With the condition, A's success leaves B's
 * marker (and any failure recorded after A started) in place.
 *
 * Clearing on any completed sync is safe even for a delivery that is not the
 * newest: syncHistoryForTenant diffs from the stored cursor, so a completed run
 * has covered every change up to its own historyId, failed predecessors
 * included.
 */
export async function clearWebhookMarker(tenantId: string, markerAt: Date): Promise<void> {
  await db
    .update(gmailTenantMappings)
    .set({ lastWebhookFailureAt: null, lastWebhookFailureReason: null })
    .where(
      and(
        eq(gmailTenantMappings.tenantId, tenantId),
        // Compared at millisecond precision. markerAt is a JS Date (ms) that
        // round-trips through an event as an ISO string; the column is
        // microsecond. A marker written by SQL now() — an operator, or any
        // future writer — stores e.g. .390939 while markerAt reads .390, so a
        // plain <= is false, the marker never clears, and the resume cron
        // re-probes the mailbox every hour. Found in local testing.
        lte(sql`date_trunc('milliseconds', ${gmailTenantMappings.lastWebhookFailureAt})`, markerAt),
      ),
    );
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

/**
 * Throw instead of calling Gmail with credentials already proven dead.
 *
 * Reaching this means corsair attempted a refresh and failed, so every call
 * would 401. Skipping is not merely an optimisation: repeated failed auth on
 * one mailbox is exactly the traffic that attracts a rate-limit penalty, which
 * would then read as a quota problem on top of an auth one.
 */
export async function assertAuthHealthy(
  tenantId: string,
  ctx: GmailCallContext,
): Promise<void> {
  const row = await getCachedRow(tenantId);
  if (!row.authFailedAt) return;

  logger.info("[GMAIL] call skipped, mailbox authentication failed", {
    tenantId,
    incidentId: deriveIncidentId(tenantId, row.authFailedAt),
    policyVersion: COOLDOWN_POLICY_VERSION,
    fromState: "AUTH_FAILED",
    toState: "AUTH_FAILED",
    trigger: ctx.trigger,
    operation: ctx.operation,
    targetId: ctx.targetId,
    authFailedAt: row.authFailedAt.toISOString(),
    reason: row.authFailureReason,
    blockedForMs: Date.now() - row.authFailedAt.getTime(),
  });

  throw new GmailAuthError(
    tenantId,
    `Gmail authentication failed for tenant ${tenantId}: ${row.authFailureReason ?? "unknown"}`,
    401,
  );
}

/**
 * The single pre-flight gate for any Gmail call: operator pause, then dead
 * credentials, then quota cooldown.
 *
 * Pause is checked FIRST and deliberately. A paused mailbox must make zero
 * calls regardless of its quota state — that is the whole point of the switch,
 * and the case it exists for (proving a Gmail penalty window by going silent)
 * is one where the mailbox is also cooling down. Checking cooldown first would
 * report the wrong reason for the skip.
 *
 * AUTH IS CHECKED BEFORE COOLDOWN, for the same "report the true reason"
 * argument. A mailbox with dead credentials will usually also be carrying a
 * cooldown; announcing "cooling down" for it describes a symptom and hides the
 * cause, and the operator waits out a window that will never help.
 *
 * NOT GATED HERE: the authentication-recovery call in gmail-request.ts. That is
 * the one operation which must run *during* a cooldown — gating it is precisely
 * what deadlocked production on 2026-08-25 (cooldown → blocks refresh → token
 * stays stale → 401 → cooldown). See the invariant comment in that file.
 *
 * All three throw rather than returning a boolean, for the same reason: a
 * caller that forgets to check a return value silently makes the call.
 */
export async function assertSyncAllowed(
  tenantId: string,
  ctx: GmailCallContext,
): Promise<void> {
  await assertNotPaused(tenantId, ctx);
  await assertAuthHealthy(tenantId, ctx);
  await assertNotCoolingDown(tenantId, ctx);
}

/** Test seam only — the memo is process-global and would leak between cases. */
export function __resetCooldownMemo(): void {
  memo.clear();
}
