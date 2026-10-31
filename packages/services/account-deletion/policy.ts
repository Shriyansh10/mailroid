/**
 * Account deletion — every decision, no IO.
 *
 * The commands in `service.ts` load state, ask this module, and then act. Each
 * gate that can refuse a fence or a delete lives here as a pure function, so
 * "can this developer delete this account right now" has one answer, testable
 * without a database (`policy.test.ts`).
 *
 * THE FLOW (D-012). Nothing here advances a request by itself:
 *   SUBMITTED ─fence (dev)→ FENCED ─≥12 h, delete (dev)→ PURGING → VERIFYING → COMPLETED
 * with WITHDRAWN / REJECTED from SUBMITTED, CANCELLED from FENCED, and
 * PURGE_FAILED / AWAITING_SEAL / INTEGRITY_INCIDENT for the unhappy paths.
 */

import type { DeletionOrgContext, DeletionStepRecord } from "@repo/database/models/account-deletion";

export type DeletionStatus =
  | "SUBMITTED"
  | "WITHDRAWN"
  | "REJECTED"
  | "FENCED"
  | "CANCELLED"
  | "PURGING"
  | "VERIFYING"
  | "AWAITING_SEAL"
  | "PURGE_FAILED"
  | "COMPLETED"
  | "INTEGRITY_INCIDENT";

export const TERMINAL_STATUSES: readonly DeletionStatus[] = ["WITHDRAWN", "REJECTED", "CANCELLED", "COMPLETED"];

/** The only legal moves. Anything else is a bug or a race, and is refused. */
export const TRANSITIONS: Readonly<Record<DeletionStatus, readonly DeletionStatus[]>> = {
  SUBMITTED: ["FENCED", "WITHDRAWN", "REJECTED"],
  FENCED: ["PURGING", "CANCELLED"],
  PURGING: ["VERIFYING", "PURGE_FAILED"],
  VERIFYING: ["COMPLETED", "AWAITING_SEAL", "PURGE_FAILED"],
  AWAITING_SEAL: ["COMPLETED", "PURGE_FAILED"],
  PURGE_FAILED: ["PURGING"],
  COMPLETED: ["INTEGRITY_INCIDENT"],
  INTEGRITY_INCIDENT: ["AWAITING_SEAL", "PURGING"],
  WITHDRAWN: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransition(from: DeletionStatus, to: DeletionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** At least this long between a confirmed fence and the delete command. */
export const DELETE_WAIT_MS = 12 * 60 * 60 * 1000;
/** The panel flags a fenced request that has waited longer than this. */
export const STALE_FENCE_MS = 24 * 60 * 60 * 1000;

/**
 * Upper bound on how long a write admitted before the fence can still land in
 * object storage: no presigned URL exists (uploads are server-side PutObject),
 * so this is the longest server request plus clock skew. 12 h of waiting
 * dwarfs it; it is recorded so the verify scan can prove it started after it.
 */
export const T_LAST_MARGIN_MS = 15 * 60 * 1000;

/**
 * How long the writer drain waits on any one table for the transactions
 * already writing it to finish (drain.ts). New writes to that table queue for
 * at most this long; past it the drain step FAILS and fence-retry runs it again.
 */
export const DRAIN_LOCK_TIMEOUT_MS = 10_000;

// ── Retention (owner decisions, 2026-10-31) ──────────────────────────

/**
 * How long a closed request keeps its audit detail. After this,
 * `account:retention` deletes its events and cuts the row to a skeleton.
 */
export const DELETION_AUDIT_RETENTION_DAYS = 365;
/** Job runs that targeted a deleted account, counted from the later of run and deletion. */
export const DEVELOPER_JOB_RUN_RETENTION_DAYS = 90;
/**
 * Suppression markers. Not a separate owner decision: it follows the deletion
 * audit, because once the audit is gone the reviewer has nothing to review a
 * match against. Change both together, or record a decision for a different one.
 */
export const SUPPRESSION_RETENTION_DAYS = DELETION_AUDIT_RETENTION_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The period stamped on a NEW marker as `expires_at`:
 * DELETION_SUPPRESSION_RETENTION_DAYS, else SUPPRESSION_RETENTION_DAYS. A
 * marker keeps the expiry it was written with; changing the variable does not
 * move existing markers.
 */
export function suppressionRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DELETION_SUPPRESSION_RETENTION_DAYS?.trim();
  if (!raw || !/^\d+$/.test(raw) || Number(raw) <= 0) return SUPPRESSION_RETENTION_DAYS;
  return Number(raw);
}

/**
 * Billing records are kept for the period the applicable accounting law sets,
 * which depends on jurisdiction and record type — so it is configuration, not
 * a constant. Unset (or unparseable) means "no period configured", and then
 * nothing in billing ever expires.
 */
export function billingRetentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.BILLING_RETENTION_DAYS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export type RetentionCategory = "DELETION_AUDIT" | "SUPPRESSION_MARKER" | "DEVELOPER_JOB_RUN" | "BILLING_RECORD";

export type RetentionBlock = "LEGAL_HOLD" | "OPEN_REVIEW" | "NO_BILLING_PERIOD" | "NOT_YET_DUE";

/**
 * Is one record due to expire? Pure: the caller supplies its age anchor and
 * what might block it. A legal hold always wins; so does an open
 * re-registration review on a marker; billing never expires without a
 * configured period.
 */
export function retentionVerdict(input: {
  category: RetentionCategory;
  /** The instant the retention clock started for this record. */
  since: Date;
  now: Date;
  legalHold: boolean;
  openReview?: boolean;
  billingDays?: number | null;
  /** A marker's own `expires_at`, which wins over `since` + period. */
  expiresAt?: Date;
}): { due: true } | { due: false; block: RetentionBlock; dueAt: Date | null } {
  const days =
    input.category === "DELETION_AUDIT"
      ? DELETION_AUDIT_RETENTION_DAYS
      : input.category === "SUPPRESSION_MARKER"
        ? SUPPRESSION_RETENTION_DAYS
        : input.category === "DEVELOPER_JOB_RUN"
          ? DEVELOPER_JOB_RUN_RETENTION_DAYS
          : (input.billingDays ?? null);
  if (input.legalHold) return { due: false, block: "LEGAL_HOLD", dueAt: null };
  if (input.openReview) return { due: false, block: "OPEN_REVIEW", dueAt: null };
  if (days === null) return { due: false, block: "NO_BILLING_PERIOD", dueAt: null };
  const dueAt = input.expiresAt ?? new Date(input.since.getTime() + days * DAY_MS);
  return input.now.getTime() >= dueAt.getTime() ? { due: true } : { due: false, block: "NOT_YET_DUE", dueAt };
}

// ── Verification: what the deletion report can and cannot prove ──────

/**
 * Printed with every deletion report, next to the checks the run made itself.
 * The run's own queries are "automatically verified"; these are the three
 * other kinds of evidence, stated so the report never claims more than it has.
 */
export const VERIFICATION_LIMITS = {
  integrationTests: [
    "The fence trigger rejects INSERT/UPDATE for a fenced tenant and allows the purge (service.integration, service.postgres, fence-trigger tests).",
    "The writer drain stops a pre-fence write surviving COMPLETED (service.postgres test, real Postgres).",
    "Every account-deletion tRPC procedure except the user's own request/mine/withdraw is a developerProcedure (access.test).",
    "A re-registration is flagged and restores no old data or org membership (retention.integration test).",
    "ai_usage.metadata can hold only numbers, booleans and a closed set of tag literals under literal keys, at every call site (ai-usage-metadata test); it is not scanned per deletion.",
  ],
  recordedOnly: [
    "revokeGoogleGrant: Google's response to /revoke is recorded. It does not prove the entry has left the user's Google 'Third-party apps with account access' page.",
    "stopGmailWatch / stopCalendarChannel: Google's response is recorded; nothing re-reads the watch afterwards.",
    "developer_job_runs.actor_email and account_deletion_event actor fields of DEVELOPER actors are kept on purpose: operator accountability.",
  ],
  manual: [
    "Google 'Third-party apps with account access' no longer lists Mailroid (test account only).",
    "Database backups taken before completion still hold the account until they age out; reconcile with account:ledger-reconcile after any restore.",
    "Processors (the AI provider, logging) follow their own retention.",
    "RESTRICTED records are restricted at the application route (DEVELOPER role) and the admin CLI. There is no database-level isolation: anyone with database credentials can read them.",
    "BILLING_RETENTION_DAYS matches the legal period for the jurisdiction and record type; the system cannot check this.",
  ],
} as const;

/**
 * Fence steps, in run order.
 *
 * CONFIRMING (all must succeed before the fence counts as confirmed and the
 * 12 h clock starts; none can be waived with --accept-unresolved):
 *   drainWriters     every transaction that was writing a fenced table when
 *                    the fence committed has finished (drain.ts). Runs first.
 *                    Without it, a write admitted before the fence could
 *                    commit after the deletion was marked COMPLETED.
 *   revokeSessions   every session row deleted — the user is signed out.
 *   stopGmailWatch   Gmail confirms users.stop. Runs BEFORE pauseSync because
 *                    stopGmailWatch refuses to call Google for a paused tenant.
 *   pauseSync        a tenant `disabled` pause with blockWatchRenewal, which
 *                    every Gmail call, calendar sync and both watch crons
 *                    already honour (gmail/pause.ts).
 *
 * RESOLVABLE (retried; deletion needs each DONE, SKIPPED as not applicable, or
 * explicitly accepted by the developer with a reason):
 *   writeLedger      off-database record of the deletion. Deferred by the
 *                    owner (ledger.ts LEDGER_DEFERRAL): with no ledger
 *                    configured it records DEFERRED_BY_OWNER, which resolves
 *                    the step without claiming a write. A ledger that is
 *                    configured but broken FAILS; it is never marked done.
 *   stopCalendarChannel, revokeGoogleGrant, releaseConnections, resolveOrgs.
 */
export const FENCE_STEPS = [
  "drainWriters",
  "writeLedger",
  "revokeSessions",
  "stopGmailWatch",
  "pauseSync",
  "stopCalendarChannel",
  "revokeGoogleGrant",
  "releaseConnections",
  "resolveOrgs",
] as const;
export type FenceStep = (typeof FENCE_STEPS)[number];

export const CONFIRMING_STEPS: readonly FenceStep[] = ["drainWriters", "revokeSessions", "stopGmailWatch", "pauseSync"];
export const RESOLVABLE_STEPS: readonly FenceStep[] = FENCE_STEPS.filter((s) => !CONFIRMING_STEPS.includes(s));

export type Refusal = { ok: false; code: string; message: string };
export type Allowed = { ok: true };
export type Verdict = Allowed | Refusal;

const refuse = (code: string, message: string): Refusal => ({ ok: false, code, message });

export type LastOwnerChoice =
  | { kind: "SUCCESSOR"; email: string }
  | { kind: "VACANT" }
  | { kind: "DISSOLVE" };

/**
 * May the developer fence this request?
 *
 * Org members need `orgConfirmed`: the confirmation happens outside Mailroid,
 * by email, and the flag is the developer saying it has. A last owner also
 * needs a choice for each org they would otherwise leave ownerless. Nothing is
 * defaulted — an org without a choice refuses the whole fence.
 */
export function fenceVerdict(input: {
  status: DeletionStatus;
  orgContext: DeletionOrgContext;
  orgConfirmed: boolean;
  lastOwnerChoices: Record<string, LastOwnerChoice>;
}): Verdict {
  if (input.status !== "SUBMITTED") {
    return refuse("WRONG_STATUS", `Only a SUBMITTED request can be fenced (this one is ${input.status}).`);
  }
  const ctx = input.orgContext;
  if (ctx.type === "ORG_MEMBER") {
    if (!input.orgConfirmed) {
      const names = ctx.orgs.map((o) => o.orgName).join(", ");
      return refuse(
        "ORG_NOT_CONFIRMED",
        `This user belongs to ${names}. Confirm with the organization by email first, then pass --org-confirmed.`,
      );
    }
    const missing = ctx.orgs.filter((o) => o.lastOwner && !input.lastOwnerChoices[o.orgId]);
    if (missing.length > 0) {
      return refuse(
        "LAST_OWNER_CHOICE_REQUIRED",
        `The user is the last owner of ${missing.map((o) => `${o.orgName} (${o.orgId})`).join(", ")}. ` +
          `Pass --org <id>=successor:<email>|vacant|dissolve for each.`,
      );
    }
    for (const o of ctx.orgs) {
      const choice = input.lastOwnerChoices[o.orgId];
      if (choice?.kind === "SUCCESSOR" && !choice.email.includes("@")) {
        return refuse("BAD_SUCCESSOR", `Successor for ${o.orgName} is not an email address.`);
      }
    }
  }
  return { ok: true };
}

/**
 * May the developer start deleting? Every condition is checked; the first
 * failing one is reported. Order matters only for the message.
 */
export function deleteVerdict(input: {
  status: DeletionStatus;
  now: Date;
  fencedConfirmedAt: Date | null;
  deleteEligibleAt: Date | null;
  steps: Record<string, DeletionStepRecord>;
  acceptUnresolved: string[];
  acceptReason: string | null;
  fenceInstalled: boolean;
  deletionEnabled: boolean;
  onTestAllowlist: boolean;
}): Verdict {
  if (input.status !== "FENCED" && input.status !== "PURGE_FAILED") {
    return refuse("WRONG_STATUS", `Only a FENCED request can be deleted (this one is ${input.status}).`);
  }
  if (input.status === "FENCED") {
    // The step records are checked too: a request confirmed before a step
    // became confirming (drainWriters) must not pass on its old timestamp.
    if (!input.fencedConfirmedAt || !input.deleteEligibleAt || !fenceConfirmed(input.steps)) {
      return refuse(
        "FENCE_NOT_CONFIRMED",
        "The fence is not confirmed: the writer drain, sessions, Gmail watch and sync pause have not all succeeded. Run account:fence-retry.",
      );
    }
    if (input.now.getTime() < input.deleteEligibleAt.getTime()) {
      const mins = Math.ceil((input.deleteEligibleAt.getTime() - input.now.getTime()) / 60000);
      return refuse(
        "TOO_EARLY",
        `Deletion is allowed from ${input.deleteEligibleAt.toISOString()} (12 h after the fence was confirmed), ${mins} min from now.`,
      );
    }
  }
  if (!input.fenceInstalled) {
    return refuse(
      "FENCE_NOT_INSTALLED",
      "The tenant fence trigger is missing from one or more tables. Run the migrations; deletion is refused until it is complete.",
    );
  }
  if (!input.deletionEnabled && !input.onTestAllowlist) {
    return refuse(
      "DELETION_DISABLED",
      "DELETION_ENABLED is not true and this account is not on DELETION_TEST_ALLOWLIST.",
    );
  }
  const waived = input.acceptUnresolved.filter((s) => (CONFIRMING_STEPS as readonly string[]).includes(s));
  if (waived.length > 0) {
    return refuse(
      "CANNOT_ACCEPT",
      `${waived.join(", ")} confirm${waived.length === 1 ? "s" : ""} the fence and can't be accepted unresolved. Run account:fence-retry until it succeeds.`,
    );
  }
  const unresolved = unresolvedSteps(input.steps);
  const notAccepted = unresolved.filter((s) => !input.acceptUnresolved.includes(s));
  if (notAccepted.length > 0) {
    return refuse(
      "STEPS_UNRESOLVED",
      `Fence steps not done: ${notAccepted.join(", ")}. Retry them, or pass --accept-unresolved=${notAccepted.join(",")} --reason "...".`,
    );
  }
  if (input.acceptUnresolved.length > 0 && !input.acceptReason?.trim()) {
    return refuse("REASON_REQUIRED", "--accept-unresolved needs --reason.");
  }
  return { ok: true };
}

/**
 * Fence steps that are not resolved: neither DONE, SKIPPED (not applicable),
 * accepted with a reason, nor deferred by the owner (the ledger).
 */
export function unresolvedSteps(steps: Record<string, DeletionStepRecord>): FenceStep[] {
  return FENCE_STEPS.filter((s) => {
    const st = steps[s]?.status;
    return st !== "DONE" && st !== "SKIPPED" && st !== "ACCEPTED_UNRESOLVED" && st !== "DEFERRED_BY_OWNER";
  });
}

/** Did the steps that confirm the fence all succeed? */
export function fenceConfirmed(steps: Record<string, DeletionStepRecord>): boolean {
  return CONFIRMING_STEPS.every((s) => steps[s]?.status === "DONE" || steps[s]?.status === "SKIPPED");
}

export function deleteEligibleAt(fencedConfirmedAt: Date): Date {
  return new Date(fencedConfirmedAt.getTime() + DELETE_WAIT_MS);
}

/**
 * Parse `--org <id>=successor:<email>|vacant|dissolve` values. Unparseable
 * input throws rather than being skipped: a typo must not silently become
 * "no choice made" and then refuse with a confusing message, or worse, match.
 */
export function parseLastOwnerChoices(values: string[]): Record<string, LastOwnerChoice> {
  const out: Record<string, LastOwnerChoice> = {};
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new Error(`--org expects <orgId>=successor:<email>|vacant|dissolve, got "${raw}"`);
    const orgId = raw.slice(0, eq).trim();
    const choice = raw.slice(eq + 1).trim();
    if (choice === "vacant") out[orgId] = { kind: "VACANT" };
    else if (choice === "dissolve") out[orgId] = { kind: "DISSOLVE" };
    else if (choice.startsWith("successor:")) out[orgId] = { kind: "SUCCESSOR", email: choice.slice(10).trim().toLowerCase() };
    else throw new Error(`--org choice for ${orgId} must be successor:<email>, vacant or dissolve, got "${choice}"`);
  }
  return out;
}

// ── Display ───────────────────────────────────────────────────────────

export type StorageBlockMode = "DENY" | "LIFECYCLE_ONLY";

/**
 * What the request is called wherever it is shown. Computed at read time from
 * the stored facts, never stored, so a label can't drift from the state it
 * describes. D-010: LIFECYCLE_ONLY completions say so.
 */
export function deletionDisplayState(r: {
  status: DeletionStatus;
  storageBlockMode: string | null;
  verifiedThrough: Date | null;
  deleteEligibleAt: Date | null;
  fencedConfirmedAt: Date | null;
  fencedAt: Date | null;
  now: Date;
}): { label: string; tone: "neutral" | "warn" | "danger" | "done" } {
  switch (r.status) {
    case "SUBMITTED":
      return { label: "Submitted — awaiting review", tone: "neutral" };
    case "WITHDRAWN":
      return { label: "Withdrawn by the user", tone: "neutral" };
    case "REJECTED":
      return { label: "Rejected", tone: "neutral" };
    case "CANCELLED":
      return { label: "Cancelled after fencing — account restored", tone: "neutral" };
    case "FENCED": {
      if (!r.fencedConfirmedAt) return { label: "Fenced — fence steps incomplete", tone: "danger" };
      if (r.deleteEligibleAt && r.now < r.deleteEligibleAt) {
        return { label: `Fenced — deletable from ${r.deleteEligibleAt.toISOString()}`, tone: "warn" };
      }
      const waited = r.deleteEligibleAt ? r.now.getTime() - r.deleteEligibleAt.getTime() : 0;
      return waited > STALE_FENCE_MS - DELETE_WAIT_MS
        ? { label: "Fenced — ready to delete, waiting over 24 h", tone: "danger" }
        : { label: "Fenced — ready to delete", tone: "warn" };
    }
    case "PURGING":
      return { label: "Deleting", tone: "warn" };
    case "VERIFYING":
      return { label: "Verifying deletion", tone: "warn" };
    case "AWAITING_SEAL":
      return { label: "Deleted — storage verification pending", tone: "warn" };
    case "PURGE_FAILED":
      return { label: "Deletion failed — retry required", tone: "danger" };
    case "INTEGRITY_INCIDENT":
      return { label: "Integrity incident — data found after completion", tone: "danger" };
    case "COMPLETED": {
      const through = r.verifiedThrough ? ` (verified ${r.verifiedThrough.toISOString()})` : "";
      return r.storageBlockMode === "DENY"
        ? { label: `Deleted${through}`, tone: "done" }
        : { label: `Deleted — late writes not blocked${through}`, tone: "done" };
    }
  }
}

/** What the user sees about their own request. No internals. */
export function userFacingStatus(status: DeletionStatus): string {
  switch (status) {
    case "SUBMITTED":
      return "Your request has been received and will be reviewed. If you're part of an organization, we'll confirm with them first.";
    case "WITHDRAWN":
      return "You withdrew this request.";
    case "REJECTED":
      return "This request was not approved. Contact support if you think that's wrong.";
    case "CANCELLED":
      return "This request was cancelled and your account was restored.";
    default:
      return "Your account is being deleted.";
  }
}
