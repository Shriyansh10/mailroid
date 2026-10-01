/**
 * What to do with a thread whose fetch failed — the pure half of
 * sync-failures.ts, kept free of the database so every branch is testable.
 *
 * QUOTA IS WAITED OUT, NEVER RETRIED IN PLACE. A quota failure does not count
 * as an attempt and is not retried until the mailbox's cooldown has ended
 * (retry.ts header: retrying inside Google's window moves it further out).
 * Only failures we cannot explain spend attempts, and they run out.
 */

import { GmailAuthError, GmailPacedOutError, gmailErrorStatus, isPermissionDenied, isQuotaError } from "./gmail-errors.ts";

export type SyncFailureKind = "quota" | "auth" | "permission" | "gone" | "paced" | "other";
export type SyncFailureStatus = "pending" | "done" | "terminal";

/** Attempts an unexplained failure gets before an operator has to look. */
export const MAX_SYNC_FAILURE_ATTEMPTS = 3;

/** Spacing between attempts at an unexplained failure: 15 min, 1 h, 4 h. */
const OTHER_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
/** A quota failure with no known window waits this long. */
const QUOTA_FALLBACK_MS = 15 * 60_000;
/** Auth-dead mailboxes are skipped by the gate anyway; re-check hourly. */
const AUTH_WAIT_MS = 60 * 60_000;
/** Our own limiter refused: the mailbox is busy, not broken. */
const PACED_WAIT_MS = 60_000;

export function kindOfSyncFailure(err: unknown): SyncFailureKind {
  // Our limiter, before any request: says nothing about the thread.
  if (err instanceof GmailPacedOutError) return "paced";
  // Includes GmailQuotaCooldownError (status 429) thrown by the pre-flight gate.
  if (isQuotaError(err)) return "quota";
  if (err instanceof GmailAuthError) return "auth";
  if (isPermissionDenied(err)) return "permission";
  if (gmailErrorStatus(err) === 404) return "gone";
  return "other";
}

/** The retry instant a quota error carries, when it carries one. */
function quotaRetryAt(err: unknown): Date | undefined {
  const at = (err as { retryAfter?: unknown } | null)?.retryAfter;
  return at instanceof Date && !Number.isNaN(at.getTime()) ? at : undefined;
}

export interface SyncFailureState {
  kind: SyncFailureKind;
  status: SyncFailureStatus;
  attempts: number;
  nextAttemptAt: Date;
}

/**
 * The state a row moves to after a failed fetch.
 *
 * @param priorAttempts attempts already spent before this one
 * @param cooldownUntil the mailbox's current cooldown end, if any — preferred
 *                      over anything on the error, because it is what the
 *                      gates will actually enforce
 */
export function nextStateAfterFailure(
  err: unknown,
  priorAttempts: number,
  now: Date,
  cooldownUntil?: Date,
): SyncFailureState {
  const kind = kindOfSyncFailure(err);
  const after = (ms: number) => new Date(now.getTime() + ms);

  switch (kind) {
    case "quota": {
      const until = cooldownUntil ?? quotaRetryAt(err);
      const next = until && until.getTime() > now.getTime() ? until : after(QUOTA_FALLBACK_MS);
      return { kind, status: "pending", attempts: priorAttempts, nextAttemptAt: next };
    }
    case "paced":
      return { kind, status: "pending", attempts: priorAttempts, nextAttemptAt: after(PACED_WAIT_MS) };
    case "auth":
      return { kind, status: "pending", attempts: priorAttempts, nextAttemptAt: after(AUTH_WAIT_MS) };
    case "permission":
    case "gone":
      // Retrying changes nothing. Kept visible for an operator.
      return { kind, status: "terminal", attempts: priorAttempts + 1, nextAttemptAt: now };
    case "other": {
      const attempts = priorAttempts + 1;
      if (attempts >= MAX_SYNC_FAILURE_ATTEMPTS) {
        return { kind, status: "terminal", attempts, nextAttemptAt: now };
      }
      const wait = OTHER_BACKOFF_MS[Math.min(attempts - 1, OTHER_BACKOFF_MS.length - 1)]!;
      return { kind, status: "pending", attempts, nextAttemptAt: after(wait) };
    }
  }
}

/**
 * A short, content-free description for last_error. Status and Google's reason
 * only — never a body, which can carry message content.
 */
export function describeSyncFailure(err: unknown): string {
  const status = gmailErrorStatus(err);
  const name = (err as { name?: unknown } | null)?.name;
  const parts = [typeof name === "string" ? name : "Error"];
  if (status !== undefined) parts.push(String(status));
  parts.push(kindOfSyncFailure(err));
  return parts.join(" ").slice(0, 200);
}
