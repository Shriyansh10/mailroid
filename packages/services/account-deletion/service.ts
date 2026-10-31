/**
 * Account deletion — the commands.
 *
 * Every function here is called by a person: the user (submit, withdraw) or a
 * developer (fence, retry, cancel, reject, delete) from the CLI or the panel.
 * Nothing schedules them and nothing calls them on a timer (D-012).
 *
 * Each state change is a compare-and-set on `status` and writes an
 * `account_deletion_event` row. Each fence or purge step records what really
 * happened — DONE only on confirmed success, the full error otherwise. The
 * gates themselves live in `policy.ts`; this file loads state, asks, acts.
 */

import { randomBytes } from "node:crypto";

import { db, pool, eq, and, desc, inArray, sql, isNull, isNotNull } from "@repo/database";
import {
  accountDeletionRequest,
  accountDeletionEvent,
  deletionReregistrationReview,
  deletionSuppression,
  tenantEpoch,
  type DeletionOrgContext,
  type DeletionStepRecord,
} from "@repo/database/models/account-deletion";
import { hashEmail, hashGoogleSub } from "@repo/database/deletion-suppression";
import { user } from "@repo/database/models/auth";
import { organization, orgMembership, orgReportingEdge } from "@repo/database/models/organization";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { messageAttachments } from "@repo/database/models/message-attachments";
import { syncPauses } from "@repo/database/models/sync-pauses";
import { corsair } from "@repo/corsair";
import { logger } from "@repo/logger";

import { stopGmailWatch } from "../gmail/watch.ts";
import { __resetPauseMemo } from "../gmail/pause.ts";
import { invalidateMailboxCache } from "../gmail/mailbox-resolver.ts";
import { addMember, changeRole, getMembership, removeMember } from "../organization/members.ts";
import { normalizeOrgEmail } from "../organization/scope-policy.ts";

import {
  DRAIN_LOCK_TIMEOUT_MS,
  FENCE_STEPS,
  TERMINAL_STATUSES,
  T_LAST_MARGIN_MS,
  VERIFICATION_LIMITS,
  billingRetentionDays,
  canTransition,
  suppressionRetentionDays,
  deleteEligibleAt,
  deleteVerdict,
  fenceConfirmed,
  fenceVerdict,
  unresolvedSteps,
  type DeletionStatus,
  type FenceStep,
  type LastOwnerChoice,
} from "./policy.ts";
import { FENCE_TRIGGER_TABLES, INVENTORY, PURGE_ORDER, type Disposition } from "./inventory.ts";
import {
  anonymisationChecks,
  anonymizeTenantRows,
  billingPseudonym,
  orgClosureChecks,
  purgeTenantRows,
  remainingTenantRows,
  type AnonContext,
  type Query,
  type VerificationCheck,
} from "./purge-db.ts";
import { purgeUserObjects, resolveDeletionStore, scanUserPrefix, scanVerifies, type DeletionObjectStore } from "./storage.ts";
import { freshAccessToken, revokeGoogleToken, stopCalendarChannelStrict } from "./google.ts";
import { resolveLedger, type DeletionLedger } from "./ledger.ts";
import { drainWriters } from "./drain.ts";

// ── Types ─────────────────────────────────────────────────────────────

export type DeletionActor =
  | { type: "USER"; userId: string; email: string }
  | { type: "DEVELOPER"; userId: string; email: string }
  | { type: "SYSTEM" };

export class DeletionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeletionError";
  }
}

export type DeletionRequestRow = typeof accountDeletionRequest.$inferSelect;
export type DeletionEventRow = typeof accountDeletionEvent.$inferSelect;

/** Test seams: everything that talks to the outside world. */
export interface DeletionDeps {
  now: () => Date;
  store: () => DeletionObjectStore | null;
  ledger: () => DeletionLedger;
  /** Per-table lock_timeout for the writer drain. Default DRAIN_LOCK_TIMEOUT_MS. */
  drainTimeoutMs?: number;
}

const defaultDeps: DeletionDeps = {
  now: () => new Date(),
  store: resolveDeletionStore,
  ledger: () => resolveLedger(),
};

const PAUSE_CREATED_BY = "account-deletion";

export { hashEmail };

/** Set at submit; nulled only when the audit expires, by which time nothing writes the ledger. */
function requireHash(row: DeletionRequestRow): string {
  if (!row.emailHash) throw new DeletionError("AUDIT_EXPIRED", `Request ${row.id} has passed its audit retention; it can no longer be acted on.`);
  return row.emailHash;
}

// ── Reads ─────────────────────────────────────────────────────────────

export async function getDeletionRequest(id: string): Promise<DeletionRequestRow | null> {
  const [row] = await db.select().from(accountDeletionRequest).where(eq(accountDeletionRequest.id, id)).limit(1);
  return row ?? null;
}

/** By request id, user id or email — the CLI accepts any of the three. */
export async function findDeletionRequest(ref: string): Promise<DeletionRequestRow | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  if (isUuid) {
    const byId = await getDeletionRequest(ref);
    if (byId) return byId;
  }
  const cond = ref.includes("@")
    ? eq(accountDeletionRequest.emailHash, hashEmail(ref))
    : eq(accountDeletionRequest.userId, ref);
  const [row] = await db
    .select()
    .from(accountDeletionRequest)
    .where(cond)
    .orderBy(desc(accountDeletionRequest.requestedAt))
    .limit(1);
  return row ?? null;
}

export async function listDeletionRequests(opts: { status?: DeletionStatus[]; limit?: number } = {}) {
  const q = db.select().from(accountDeletionRequest);
  const rows = await (opts.status?.length
    ? q.where(inArray(accountDeletionRequest.status, opts.status))
    : q
  )
    .orderBy(desc(accountDeletionRequest.requestedAt))
    .limit(opts.limit ?? 100);
  return rows;
}

export async function listDeletionEvents(requestId: string): Promise<DeletionEventRow[]> {
  return db
    .select()
    .from(accountDeletionEvent)
    .where(eq(accountDeletionEvent.requestId, requestId))
    .orderBy(accountDeletionEvent.occurredAt);
}

/** The user's own latest request, for the settings page. */
export async function getMyDeletionRequest(userId: string): Promise<DeletionRequestRow | null> {
  const [row] = await db
    .select()
    .from(accountDeletionRequest)
    .where(eq(accountDeletionRequest.userId, userId))
    .orderBy(desc(accountDeletionRequest.requestedAt))
    .limit(1);
  return row ?? null;
}

export { isTenantFenced } from "@repo/database/tenant-fence";

/**
 * Is the fence trigger installed on every table the inventory says it must be?
 * Deletion is refused when it isn't (FENCE_NOT_INSTALLED): a purge racing an
 * unfenced writer could finish "complete" with rows written behind it.
 */
export async function fenceTriggerStatus(): Promise<{ installed: boolean; missing: string[] }> {
  const res = await pool.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = 'trg_tenant_fence' AND NOT t.tgisinternal AND t.tgenabled <> 'D'`,
  );
  const have = new Set(res.rows.map((r) => r.table_name));
  const missing = FENCE_TRIGGER_TABLES.filter((t) => !have.has(t));
  return { installed: missing.length === 0, missing };
}

// ── Org context ───────────────────────────────────────────────────────

export async function computeOrgContext(email: string): Promise<DeletionOrgContext> {
  const normalized = normalizeOrgEmail(email);
  const memberships = await db
    .select({ orgId: orgMembership.organizationId, orgName: organization.name, role: orgMembership.role })
    .from(orgMembership)
    .innerJoin(organization, eq(organization.id, orgMembership.organizationId))
    .where(and(eq(orgMembership.email, normalized), isNull(orgMembership.effectiveUntil)));

  if (memberships.length === 0) return { type: "INDIVIDUAL" };

  const orgs = [];
  for (const m of memberships) {
    const owners = await db
      .select({ email: orgMembership.email })
      .from(orgMembership)
      .where(
        and(
          eq(orgMembership.organizationId, m.orgId),
          eq(orgMembership.role, "OWNER"),
          isNull(orgMembership.effectiveUntil),
        ),
      );
    const [edge] = await db
      .select({ managerEmail: orgReportingEdge.managerEmail })
      .from(orgReportingEdge)
      .where(
        and(
          eq(orgReportingEdge.organizationId, m.orgId),
          eq(orgReportingEdge.subordinateEmail, normalized),
          isNull(orgReportingEdge.effectiveUntil),
        ),
      )
      .limit(1);
    const ownerEmails = owners.map((o) => o.email);
    orgs.push({
      orgId: m.orgId,
      orgName: m.orgName,
      role: m.role as "OWNER" | "MEMBER",
      managerEmail: edge?.managerEmail ?? null,
      ownerEmails,
      lastOwner: m.role === "OWNER" && ownerEmails.length === 1,
    });
  }
  return { type: "ORG_MEMBER", orgs };
}

// ── Events and transitions ───────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

async function recordEvent(
  x: Exec,
  requestId: string,
  type: string,
  actor: DeletionActor,
  detail: Record<string, unknown> | null = null,
  from: string | null = null,
  to: string | null = null,
): Promise<void> {
  await x.insert(accountDeletionEvent).values({
    requestId,
    type,
    fromStatus: from,
    toStatus: to,
    actorType: actor.type,
    actorUserId: actor.type === "SYSTEM" ? null : actor.userId,
    actorEmail: actor.type === "SYSTEM" ? null : actor.email,
    detail,
  });
}

/**
 * Compare-and-set. Only moves a request out of `from` if it is still there,
 * and only along a legal edge. The loser of a race gets CONFLICT.
 */
async function transition(
  x: Exec,
  id: string,
  from: DeletionStatus | DeletionStatus[],
  to: DeletionStatus,
  actor: DeletionActor,
  patch: Partial<typeof accountDeletionRequest.$inferInsert> = {},
  detail: Record<string, unknown> | null = null,
): Promise<DeletionRequestRow> {
  const froms = Array.isArray(from) ? from : [from];
  for (const f of froms) {
    if (!canTransition(f, to)) throw new DeletionError("ILLEGAL_TRANSITION", `${f} → ${to} is not a legal move.`);
  }
  // Entering a terminal status starts the audit retention clock.
  const closing = TERMINAL_STATUSES.includes(to) ? { closedAt: new Date() } : {};
  const [row] = await x
    .update(accountDeletionRequest)
    .set({ ...patch, ...closing, status: to })
    .where(and(eq(accountDeletionRequest.id, id), inArray(accountDeletionRequest.status, froms)))
    .returning();
  if (!row) {
    throw new DeletionError("CONFLICT", `Request ${id} is no longer ${froms.join(" or ")}; someone else moved it. Reload and retry.`);
  }
  await recordEvent(x, id, "TRANSITION", actor, detail, froms.length === 1 ? froms[0]! : froms.join("|"), to);
  return row;
}

async function saveStep(id: string, step: string, rec: DeletionStepRecord, actor: DeletionActor): Promise<void> {
  await db
    .update(accountDeletionRequest)
    .set({ steps: sql`${accountDeletionRequest.steps} || ${JSON.stringify({ [step]: rec })}::jsonb` })
    .where(eq(accountDeletionRequest.id, id));
  await recordEvent(db, id, `STEP_${rec.status}`, actor, { step, attempts: rec.attempts, error: rec.error ?? null, ...rec.detail });
}

function requireRequest(row: DeletionRequestRow | null, ref: string): DeletionRequestRow {
  if (!row) throw new DeletionError("NOT_FOUND", `No deletion request for "${ref}".`);
  return row;
}

function requireConfirmEmail(row: DeletionRequestRow, typed: string): void {
  if (!row.email || typed.trim().toLowerCase() !== row.email.toLowerCase()) {
    throw new DeletionError("CONFIRMATION_MISMATCH", "The typed email does not match the account. Nothing was changed.");
  }
}

// ── User actions ─────────────────────────────────────────────────────

export async function submitDeletionRequest(input: {
  userId: string;
  kind: "DEPARTURE" | "PRIVACY_ERASURE";
  reason: string;
  details?: string | null;
}): Promise<DeletionRequestRow> {
  const [u] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, input.userId)).limit(1);
  if (!u) throw new DeletionError("NOT_FOUND", "User not found.");
  const reason = input.reason.trim();
  if (reason.length < 3) throw new DeletionError("REASON_REQUIRED", "Please give a reason.");

  const open = await db
    .select({ id: accountDeletionRequest.id })
    .from(accountDeletionRequest)
    .where(
      and(
        eq(accountDeletionRequest.userId, u.id),
        sql`${accountDeletionRequest.status} not in ('WITHDRAWN','REJECTED','CANCELLED','COMPLETED')`,
      ),
    )
    .limit(1);
  if (open.length) throw new DeletionError("ALREADY_OPEN", "You already have a deletion request in progress.");

  const orgContext = await computeOrgContext(u.email);
  const actor: DeletionActor = { type: "USER", userId: u.id, email: u.email };

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(accountDeletionRequest)
      .values({
        userId: u.id,
        email: u.email,
        emailHash: hashEmail(u.email),
        kind: input.kind,
        reason,
        details: input.details?.trim() || null,
        orgContext,
        status: "SUBMITTED",
      })
      .returning();
    await recordEvent(tx, row!.id, "SUBMITTED", actor, { kind: input.kind, orgContext: orgContext.type }, null, "SUBMITTED");
    return row!;
  });
}

export async function withdrawDeletionRequest(userId: string): Promise<DeletionRequestRow> {
  const row = await getMyDeletionRequest(userId);
  if (!row || row.status !== "SUBMITTED") {
    throw new DeletionError("NOT_WITHDRAWABLE", "Only a request that hasn't been processed yet can be withdrawn.");
  }
  return transition(db, row.id, "SUBMITTED", "WITHDRAWN", { type: "USER", userId, email: row.email ?? "" });
}

// ── Developer actions ────────────────────────────────────────────────

export async function rejectDeletionRequest(input: { id: string; actor: DeletionActor; reason: string }) {
  if (!input.reason.trim()) throw new DeletionError("REASON_REQUIRED", "A rejection needs a reason.");
  return transition(db, input.id, "SUBMITTED", "REJECTED", input.actor, { decidedBy: actorLabel(input.actor) }, { reason: input.reason });
}

/**
 * account:fence. One transaction flips the tenant to FENCED (the trigger
 * starts rejecting writes from this commit on) and moves the request to
 * FENCED. Then the fence steps run; their results are returned and recorded.
 */
export async function fenceAccount(
  input: {
    id: string;
    actor: DeletionActor;
    confirmEmail: string;
    orgConfirmed: boolean;
    lastOwnerChoices: Record<string, LastOwnerChoice>;
  },
  deps: DeletionDeps = defaultDeps,
): Promise<{ request: DeletionRequestRow; steps: Record<string, DeletionStepRecord> }> {
  const row = requireRequest(await getDeletionRequest(input.id), input.id);
  requireConfirmEmail(row, input.confirmEmail);

  // Re-read org membership now: the context stored at submit time may be stale.
  const liveOrgContext = row.email ? await computeOrgContext(row.email) : row.orgContext;
  const verdict = fenceVerdict({
    status: row.status,
    orgContext: liveOrgContext,
    orgConfirmed: input.orgConfirmed,
    lastOwnerChoices: input.lastOwnerChoices,
  });
  if (!verdict.ok) throw new DeletionError(verdict.code, verdict.message);

  const now = deps.now();
  const initialSteps: Record<string, DeletionStepRecord> = {};
  for (const s of FENCE_STEPS) initialSteps[s] = { status: "PENDING", attempts: 0, at: null };

  const fenced = await db.transaction(async (tx) => {
    const [epoch] = await tx
      .insert(tenantEpoch)
      .values({ tenantId: row.userId, epoch: 1, state: "FENCED", everFenced: true, updatedAt: now })
      .onConflictDoUpdate({
        target: tenantEpoch.tenantId,
        set: { epoch: sql`${tenantEpoch.epoch} + 1`, state: "FENCED", everFenced: true, updatedAt: now },
      })
      .returning();
    return transition(
      tx,
      row.id,
      "SUBMITTED",
      "FENCED",
      input.actor,
      {
        fencedAt: now,
        fencedEpoch: epoch!.epoch,
        tLast: new Date(now.getTime() + T_LAST_MARGIN_MS),
        orgContext: liveOrgContext,
        orgConfirmedAt: liveOrgContext.type === "ORG_MEMBER" ? now : null,
        orgConfirmedBy: liveOrgContext.type === "ORG_MEMBER" ? actorLabel(input.actor) : null,
        orgOutcome: Object.keys(input.lastOwnerChoices).length ? (input.lastOwnerChoices as Record<string, unknown>) : null,
        decidedBy: actorLabel(input.actor),
        steps: initialSteps,
      },
      { orgConfirmed: input.orgConfirmed, orgContext: liveOrgContext.type, epoch: epoch!.epoch },
    );
  });

  logger.info("[account-deletion] tenant fenced", { requestId: row.id, tenantId: row.userId, epoch: fenced.fencedEpoch });
  return runFenceSteps({ id: row.id, actor: input.actor }, deps);
}

/**
 * Run (or re-run) every fence step that isn't done. Safe to repeat: each step
 * is idempotent, and DONE steps are skipped. Sets fencedConfirmedAt — and with
 * it deleteEligibleAt — the first time the confirming steps have all succeeded.
 */
export async function runFenceSteps(
  input: { id: string; actor: DeletionActor },
  deps: DeletionDeps = defaultDeps,
): Promise<{ request: DeletionRequestRow; steps: Record<string, DeletionStepRecord> }> {
  let row = requireRequest(await getDeletionRequest(input.id), input.id);
  const allowed: DeletionStatus[] = ["FENCED", "PURGE_FAILED"];
  if (!allowed.includes(row.status)) {
    throw new DeletionError("WRONG_STATUS", `Fence steps run only while FENCED (this request is ${row.status}).`);
  }

  for (const step of FENCE_STEPS) {
    const prev = row.steps[step];
    if (prev && (prev.status === "DONE" || prev.status === "SKIPPED" || prev.status === "ACCEPTED_UNRESOLVED")) continue;
    // Re-check before every step: a concurrent cancel must stop the run.
    const fresh = await getDeletionRequest(row.id);
    if (!fresh || !allowed.includes(fresh.status)) {
      throw new DeletionError("CONFLICT", `Request moved to ${fresh?.status} while fence steps were running; stopped.`);
    }
    row = fresh;
    const attempts = (prev?.attempts ?? 0) + 1;
    let rec: DeletionStepRecord;
    try {
      const r = await FENCE_STEP_IMPL[step](row, deps, input.actor);
      rec = { status: r.status, attempts, at: deps.now().toISOString(), error: r.error ?? null, detail: r.detail };
    } catch (err) {
      rec = { status: "FAILED", attempts, at: deps.now().toISOString(), error: errorText(err) };
    }
    if (rec.status === "FAILED") {
      logger.error("[account-deletion] fence step failed", { requestId: row.id, step, attempts, error: rec.error });
    }
    await saveStep(row.id, step, rec, input.actor);
    row = { ...row, steps: { ...row.steps, [step]: rec } };
  }

  if (!row.fencedConfirmedAt && fenceConfirmed(row.steps)) {
    const confirmedAt = deps.now();
    const [updated] = await db
      .update(accountDeletionRequest)
      .set({ fencedConfirmedAt: confirmedAt, deleteEligibleAt: deleteEligibleAt(confirmedAt) })
      .where(and(eq(accountDeletionRequest.id, row.id), isNull(accountDeletionRequest.fencedConfirmedAt)))
      .returning();
    if (updated) {
      await recordEvent(db, row.id, "FENCE_CONFIRMED", input.actor, { deleteEligibleAt: updated.deleteEligibleAt?.toISOString() });
      row = updated;
    }
  }
  const final = requireRequest(await getDeletionRequest(row.id), row.id);
  return { request: final, steps: final.steps };
}

type StepResult = { status: DeletionStepRecord["status"]; error?: string; detail?: Record<string, unknown> };

const FENCE_STEP_IMPL: Record<FenceStep, (row: DeletionRequestRow, deps: DeletionDeps, actor: DeletionActor) => Promise<StepResult>> = {
  async drainWriters(_row, deps) {
    const r = await drainWriters(() => pool.connect(), FENCE_TRIGGER_TABLES, deps.drainTimeoutMs ?? DRAIN_LOCK_TIMEOUT_MS);
    return r.ok
      ? { status: "DONE", detail: { tablesDrained: r.tables, ...(Object.keys(r.slow).length ? { slowMs: r.slow } : {}) } }
      : { status: "FAILED", error: r.reason, detail: { table: r.table, pgCode: r.code, drainedBeforeFailure: r.drained.length } };
  },

  async writeLedger(row, deps) {
    const ledger = deps.ledger(); // throws LedgerNotConfiguredError → FAILED with the reason
    await ledger.write({
      requestId: row.id,
      userId: row.userId,
      emailHash: requireHash(row),
      event: "FENCED",
      fencedEpoch: row.fencedEpoch,
      at: deps.now().toISOString(),
    });
    return { status: "DONE" };
  },

  async revokeSessions(row) {
    const res = await pool.query(`DELETE FROM "session" WHERE user_id = $1`, [row.userId]);
    return { status: "DONE", detail: { sessionsRevoked: res.rowCount ?? 0 } };
  },

  async stopGmailWatch(row) {
    const [mapping] = await db
      .select({ watchTopic: gmailTenantMappings.watchTopic })
      .from(gmailTenantMappings)
      .where(eq(gmailTenantMappings.tenantId, row.userId))
      .limit(1);
    if (!mapping) return { status: "SKIPPED", detail: { why: "no Gmail mailbox connected" } };
    if (!mapping.watchTopic) return { status: "SKIPPED", detail: { why: "no watch recorded for this mailbox in this environment" } };
    const r = await stopGmailWatch(row.userId);
    return r.stopped ? { status: "DONE" } : { status: "FAILED", error: `users.stop not confirmed: ${r.reason ?? "unknown"}` };
  },

  async pauseSync(row) {
    const [existing] = await db.select().from(syncPauses).where(and(eq(syncPauses.scope, "tenant"), eq(syncPauses.tenantId, row.userId))).limit(1);
    if (existing && existing.createdBy === PAUSE_CREATED_BY) {
      return { status: "DONE", detail: { pause: "already in place" } };
    }
    const reason = `account deletion request ${row.id}`;
    if (existing) {
      await db
        .update(syncPauses)
        .set({ mode: "disabled", blockWatchRenewal: true, reason, createdBy: PAUSE_CREATED_BY, expiresAt: null })
        .where(eq(syncPauses.id, existing.id));
    } else {
      await db.insert(syncPauses).values({
        scope: "tenant",
        tenantId: row.userId,
        mode: "disabled",
        blockWatchRenewal: true,
        reason,
        createdBy: PAUSE_CREATED_BY,
      });
    }
    __resetPauseMemo();
    return {
      status: "DONE",
      detail: existing
        ? { replacedPause: { mode: existing.mode, blockWatchRenewal: existing.blockWatchRenewal, reason: existing.reason, createdBy: existing.createdBy, expiresAt: existing.expiresAt?.toISOString() ?? null } }
        : {},
    };
  },

  async stopCalendarChannel(row) {
    const mappings = await db
      .select()
      .from(calendarTenantMappings)
      .where(and(eq(calendarTenantMappings.tenantId, row.userId), isNotNull(calendarTenantMappings.channelId)));
    if (mappings.length === 0) return { status: "SKIPPED", detail: { why: "no calendar channel recorded" } };

    const tenant = corsair.withTenant(row.userId) as unknown as CorsairKeys;
    let token = await safe(() => tenant.googlecalendar?.keys.get_access_token());
    const results: Record<string, unknown>[] = [];
    let failed = false;
    for (const m of mappings) {
      if (!m.channelId || !m.resourceId) {
        failed = true;
        results.push({ channel: m.channelId, outcome: "FAILED", body: "no resourceId recorded" });
        continue;
      }
      let r = token ? await stopCalendarChannelStrict(token, m.channelId, m.resourceId) : null;
      if (!r || (r.outcome === "FAILED" && r.status === 401)) {
        const refresh = await safe(() => tenant.googlecalendar?.keys.get_refresh_token());
        token = refresh ? await freshAccessToken(refresh) : null;
        r = token ? await stopCalendarChannelStrict(token, m.channelId, m.resourceId) : { outcome: "FAILED", status: null, body: "no usable calendar token" };
      }
      results.push({ channel: m.channelId, ...r });
      if (r.outcome === "FAILED") failed = true;
      else {
        await db
          .update(calendarTenantMappings)
          .set({ channelId: null, resourceId: null, watchExpiration: null })
          .where(eq(calendarTenantMappings.emailAddress, m.emailAddress));
      }
    }
    return failed
      ? { status: "FAILED", error: "one or more channels could not be stopped", detail: { results, channelExpiresAt: mappings.map((m) => m.watchExpiration?.toISOString() ?? null) } }
      : { status: "DONE", detail: { results } };
  },

  async revokeGoogleGrant(row) {
    const tenant = corsair.withTenant(row.userId) as unknown as CorsairKeys;
    const tokens = new Map<string, string>();
    for (const [label, getter] of [
      ["gmail", () => tenant.gmail?.keys.get_refresh_token()],
      ["calendar", () => tenant.googlecalendar?.keys.get_refresh_token()],
    ] as const) {
      const t = await safe(getter);
      if (t && ![...tokens.values()].includes(t)) tokens.set(label, t);
    }
    const signIn = await pool.query<{ refresh_token: string | null }>(
      `SELECT refresh_token FROM "account" WHERE user_id = $1 AND provider_id = 'google' AND refresh_token IS NOT NULL`,
      [row.userId],
    );
    for (const r of signIn.rows) if (r.refresh_token && ![...tokens.values()].includes(r.refresh_token)) tokens.set("sign-in", r.refresh_token);

    if (tokens.size === 0) return { status: "SKIPPED", detail: { why: "no Google refresh token stored" } };

    const outcomes: Record<string, unknown> = {};
    let failed = false;
    for (const [label, token] of tokens) {
      const r = await revokeGoogleToken(token);
      outcomes[label] = r;
      if (r.outcome === "FAILED") failed = true;
    }
    return failed
      ? { status: "FAILED", error: "a revoke call failed", detail: { outcomes } }
      : { status: "DONE", detail: { outcomes, note: "ALREADY_INVALID classification unverified against a real account (Phase 0 step 1)" } };
  },

  async releaseConnections(row) {
    // Never before the grant is revoked: these rows hold the token revoke needs.
    const revoke = row.steps.revokeGoogleGrant?.status;
    if (revoke !== "DONE" && revoke !== "SKIPPED") {
      return { status: "PENDING", error: "waiting for revokeGoogleGrant to succeed" };
    }
    const ids = (await pool.query<{ id: string }>(`SELECT id FROM corsair_accounts WHERE tenant_id = $1`, [row.userId])).rows.map((r) => r.id);
    if (ids.length === 0) return { status: "SKIPPED", detail: { why: "no Corsair connections" } };
    await pool.query(`DELETE FROM corsair_events WHERE account_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM corsair_entities WHERE account_id = ANY($1)`, [ids]);
    const del = await pool.query(`DELETE FROM corsair_accounts WHERE id = ANY($1)`, [ids]);
    invalidateMailboxCache(row.userId);
    return { status: "DONE", detail: { connectionsReleased: del.rowCount ?? 0 } };
  },

  async resolveOrgs(row, _deps, actor) {
    const choices = (row.orgOutcome ?? {}) as Record<string, LastOwnerChoice>;
    const ctx = row.orgContext;
    const lastOwnerOrgs = ctx.type === "ORG_MEMBER" ? ctx.orgs.filter((o) => o.lastOwner) : [];
    if (lastOwnerOrgs.length === 0) return { status: "SKIPPED", detail: { why: "not the last owner of any organization" } };

    // Org audit rows name the developer who ran the fence, not the departing user.
    const actorUserId = actor.type === "SYSTEM" ? row.userId : actor.userId;
    const done: Record<string, string> = {};
    for (const o of lastOwnerOrgs) {
      const choice = choices[o.orgId];
      if (!choice) return { status: "FAILED", error: `no choice recorded for ${o.orgName} (${o.orgId})` };
      if (choice.kind === "DISSOLVE") {
        await db.delete(organization).where(eq(organization.id, o.orgId));
        done[o.orgId] = "dissolved";
        continue;
      }
      const ownerEmail = choice.kind === "SUCCESSOR" ? choice.email : `vacant-owner+${o.orgId}@mailroid.invalid`;
      const existing = await getMembership(o.orgId, ownerEmail);
      if (existing) await changeRole({ organizationId: o.orgId, email: ownerEmail, role: "OWNER", actorUserId });
      else await addMember({ organizationId: o.orgId, email: ownerEmail, role: "OWNER", actorUserId });
      done[o.orgId] = choice.kind === "SUCCESSOR" ? `owner → ${ownerEmail}` : "placeholder owner added (assign a real owner later)";
    }
    return { status: "DONE", detail: done };
  },
};

/**
 * Read a key through Corsair without letting a missing accessor or a decrypt
 * failure abort the step: a missing token is reported by the caller as such.
 * Async wrapper so a synchronous throw is caught too.
 */
async function safe(fn: () => Promise<string | null> | undefined): Promise<string | null> {
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

interface CorsairKeys {
  gmail?: { keys: { get_access_token(): Promise<string | null>; get_refresh_token(): Promise<string | null> } };
  googlecalendar?: { keys: { get_access_token(): Promise<string | null>; get_refresh_token(): Promise<string | null> } };
}

/**
 * account:cancel — only while FENCED, i.e. before anything is deleted.
 * Unfences the tenant and lifts our pause (restoring an operator pause we
 * replaced). What it cannot undo is printed: revoked grants and released
 * connections need the user to reconnect.
 */
export async function cancelFence(input: { id: string; actor: DeletionActor; reason: string }, deps: DeletionDeps = defaultDeps) {
  if (!input.reason.trim()) throw new DeletionError("REASON_REQUIRED", "Cancelling needs a reason.");
  const row = requireRequest(await getDeletionRequest(input.id), input.id);
  if (row.status !== "FENCED") throw new DeletionError("WRONG_STATUS", `Only a FENCED request can be cancelled (this one is ${row.status}).`);

  const updated = await db.transaction(async (tx) => {
    await tx
      .update(tenantEpoch)
      .set({ epoch: sql`${tenantEpoch.epoch} + 1`, state: "ACTIVE", updatedAt: deps.now() })
      .where(eq(tenantEpoch.tenantId, row.userId));
    const replaced = row.steps.pauseSync?.detail?.replacedPause as
      | { mode: string; blockWatchRenewal: boolean; reason: string | null; createdBy: string | null; expiresAt: string | null }
      | undefined;
    if (replaced) {
      await tx
        .update(syncPauses)
        .set({ mode: replaced.mode, blockWatchRenewal: replaced.blockWatchRenewal, reason: replaced.reason, createdBy: replaced.createdBy, expiresAt: replaced.expiresAt ? new Date(replaced.expiresAt) : null })
        .where(and(eq(syncPauses.tenantId, row.userId), eq(syncPauses.createdBy, PAUSE_CREATED_BY)));
    } else {
      await tx.delete(syncPauses).where(and(eq(syncPauses.tenantId, row.userId), eq(syncPauses.createdBy, PAUSE_CREATED_BY)));
    }
    return transition(tx, row.id, "FENCED", "CANCELLED", input.actor, {}, { reason: input.reason });
  });
  __resetPauseMemo();

  const needs: string[] = ["The user must sign in again (sessions were revoked)."];
  if (row.steps.revokeGoogleGrant?.status === "DONE") needs.push("The Google grant was revoked: the user must reconnect Gmail and Calendar.");
  if (row.steps.releaseConnections?.status === "DONE") needs.push("Corsair connections were released: reconnecting recreates them.");
  if (row.steps.stopGmailWatch?.status === "DONE") needs.push("The Gmail watch was stopped: it is re-registered on reconnect or by gmail:renew-watch.");
  if (row.steps.resolveOrgs?.status === "DONE") needs.push("Organization ownership changes made at fence time were NOT reverted; fix them by hand if needed.");
  try {
    await deps.ledger().write({ requestId: row.id, userId: row.userId, emailHash: requireHash(row), event: "CANCELLED", fencedEpoch: row.fencedEpoch, at: deps.now().toISOString() });
  } catch (err) {
    needs.push(`Ledger not updated (${errorText(err)}).`);
  }
  return { request: updated, recoveryNeeded: needs };
}

// ── Delete ────────────────────────────────────────────────────────────

/** A RETAIN / RESTRICTED record as the report states it: kept on purpose, not left over. */
export interface RetainedRecord {
  table: string;
  disposition: Disposition;
  purpose: string;
  period: string;
  whyKept: string;
  access?: string;
}

export interface DeletionReport {
  rowsDeleted: Record<string, number>;
  storage: { deleted: number; abortedUploads: number; failures: { key: string; error: string }[]; complete: boolean } | { error: string };
  /** Rows changed per anonymised field, `table.column` → count. */
  anonymised?: Record<string, number>;
  retained: string[];
  /** Every RETAIN / RESTRICTED record, from the inventory: intentional retention. */
  retention?: RetainedRecord[];
  outside: string[];
  verification: {
    dbRemaining: Record<string, number>;
    storage: unknown;
    verified: boolean;
    /** AUTOMATICALLY VERIFIED: the queries this run made, each with what it found. */
    checks?: VerificationCheck[];
    /** What this run did NOT prove, by the kind of evidence there is instead. */
    limits?: typeof VERIFICATION_LIMITS;
  };
}

/** The intentional-retention list, straight from the inventory. */
export function retentionRecords(): RetainedRecord[] {
  return Object.entries(INVENTORY)
    .filter(([, e]) => e.disposition === "RETAIN" || e.disposition === "RESTRICTED")
    .map(([table, e]) => ({ table, disposition: e.disposition, ...e.retention! }));
}

/** Static checks over the inventory, reported with every run. */
function declarationChecks(): VerificationCheck[] {
  return Object.entries(INVENTORY)
    .filter(([, e]) => e.disposition === "RETAIN" || e.disposition === "RESTRICTED")
    .map(([table, e]) => {
      const r = e.retention;
      const ok = !!(r?.purpose && r.period && r.whyKept && (e.disposition !== "RESTRICTED" || r.access));
      return { disposition: e.disposition, table, check: `${table}: purpose, period and reason kept are declared${e.disposition === "RESTRICTED" ? ", and who may read it" : ""}`, found: ok ? 0 : 1, ok };
    });
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * account:delete. Refused unless every gate in deleteVerdict passes. Then:
 * storage, database (batched, table by table, in inventory order), org
 * membership, scrub, the user row, and verification. Ends COMPLETED only when
 * the database is empty for this tenant AND a complete storage scan that
 * started after T_last found nothing. Any failure ends PURGE_FAILED with the
 * full error; `account:retry` re-runs the (idempotent) purge.
 */
export async function deleteAccount(
  input: {
    id: string;
    actor: DeletionActor;
    confirmEmail: string;
    acceptUnresolved?: string[];
    acceptReason?: string | null;
  },
  deps: DeletionDeps = defaultDeps,
): Promise<{ request: DeletionRequestRow; report: DeletionReport }> {
  const row = requireRequest(await getDeletionRequest(input.id), input.id);
  // After a failed purge the email may already be gone from the user table but
  // it is still on the request until completion.
  requireConfirmEmail(row, input.confirmEmail);

  const fence = await fenceTriggerStatus();
  const accept = input.acceptUnresolved ?? [];
  const unknown = accept.filter((s) => !(FENCE_STEPS as readonly string[]).includes(s));
  if (unknown.length) throw new DeletionError("BAD_STEP", `Unknown step(s) in --accept-unresolved: ${unknown.join(", ")}`);

  const verdict = deleteVerdict({
    status: row.status,
    now: deps.now(),
    fencedConfirmedAt: row.fencedConfirmedAt,
    deleteEligibleAt: row.deleteEligibleAt,
    steps: row.steps,
    acceptUnresolved: accept,
    acceptReason: input.acceptReason ?? null,
    fenceInstalled: fence.installed,
    deletionEnabled: process.env.DELETION_ENABLED === "true",
    onTestAllowlist: !!row.email && envList("DELETION_TEST_ALLOWLIST").includes(row.email.toLowerCase()),
  });
  if (!verdict.ok) {
    const msg = verdict.code === "FENCE_NOT_INSTALLED" ? `${verdict.message} Missing: ${fence.missing.join(", ")}` : verdict.message;
    await recordEvent(db, row.id, "DELETE_REFUSED", input.actor, { code: verdict.code });
    throw new DeletionError(verdict.code, msg);
  }

  // Accepted-unresolved steps are recorded, with the reason, before anything is deleted.
  const acceptedSteps = unresolvedSteps(row.steps).filter((s) => accept.includes(s));
  const stepsPatch: Record<string, DeletionStepRecord> = { ...row.steps };
  for (const s of acceptedSteps) {
    stepsPatch[s] = { ...(row.steps[s] ?? { attempts: 0, at: null }), status: "ACCEPTED_UNRESOLVED", at: deps.now().toISOString() };
  }

  const purging = await transition(
    db,
    row.id,
    row.status === "PURGE_FAILED" ? "PURGE_FAILED" : "FENCED",
    "PURGING",
    input.actor,
    {
      deleteStartedAt: deps.now(),
      steps: stepsPatch,
      acceptedUnresolved: acceptedSteps.length ? { steps: acceptedSteps, reason: input.acceptReason ?? "" } : row.acceptedUnresolved,
      lastError: null,
    },
    acceptedSteps.length ? { acceptedUnresolved: acceptedSteps, reason: input.acceptReason } : null,
  );

  const report: DeletionReport = {
    rowsDeleted: {},
    storage: { error: "not run" },
    retained: [],
    outside: [
      "Mail and calendar data in the user's own Google account is untouched — Mailroid never deletes from Google.",
      "Database backups taken before completion still contain this user until they age out; the deletion ledger records this deletion so a restore can be reconciled (account:ledger-reconcile).",
      "Data already sent to processors (the AI provider, logging) follows those processors' retention.",
    ],
    verification: { dbRemaining: {}, storage: null, verified: false },
  };

  try {
    await purge(purging, report, deps, input.actor);
  } catch (err) {
    const error = errorText(err);
    logger.error("[account-deletion] purge failed", { requestId: row.id, error });
    const failed = await transition(db, row.id, "PURGING", "PURGE_FAILED", { type: "SYSTEM" }, { lastError: error, report: report as unknown as Record<string, unknown> }, { error });
    return { request: failed, report };
  }

  // ── Verify ──
  await transition(db, row.id, "PURGING", "VERIFYING", { type: "SYSTEM" });
  const remaining = await remainingTenantRows(poolQuery, row.userId);
  report.verification.dbRemaining = remaining;
  const checks = await dispositionChecks(purging, remaining);
  report.verification.checks = checks;
  report.verification.limits = VERIFICATION_LIMITS;
  const failedChecks = checks.filter((c) => !c.ok && c.disposition !== "DELETE");

  const store = deps.store();
  const scan = store ? await scanUserPrefix(store, row.userId, deps.now) : null;
  report.verification.storage = scan ?? { error: "object storage not configured here" };
  const dbClean = Object.keys(remaining).length === 0;
  const storageClean = !!scan && scanVerifies(scan, row.tLast);

  if (!dbClean || failedChecks.length > 0 || (scan && scan.complete && (scan.objects > 0 || scan.uploads > 0))) {
    const error = !dbClean
      ? `rows remain after purge: ${JSON.stringify(remaining)}`
      : failedChecks.length > 0
        ? `retention checks failed: ${failedChecks.map((c) => `${c.check} (found ${c.found})`).join("; ")}`
        : `objects remain after purge: ${scan!.objects} objects, ${scan!.uploads} uploads (e.g. ${scan!.sampleKeys.join(", ")})`;
    const failed = await transition(db, row.id, "VERIFYING", "PURGE_FAILED", { type: "SYSTEM" }, { lastError: error, report: report as unknown as Record<string, unknown> }, { error });
    return { request: failed, report };
  }

  if (!storageClean) {
    // DB is clean but storage couldn't be proven empty (incomplete listing,
    // scan not after T_last, or no store). Not COMPLETED, not failed:
    // account:verify-storage re-scans and finishes it.
    const error = !scan ? "object storage not configured here; cannot verify" : scan.complete ? "scan did not start after T_last" : `storage scan incomplete: ${scan.error}`;
    const waiting = await transition(db, row.id, "VERIFYING", "AWAITING_SEAL", { type: "SYSTEM" }, { lastError: error, report: report as unknown as Record<string, unknown>, storageBlockMode: "LIFECYCLE_ONLY" }, { error });
    return { request: waiting, report };
  }

  report.verification.verified = true;
  const completed = await complete(row.id, scan!.startedAt, report, deps);
  // The completion transaction checks the request's own rows; if they failed,
  // so did verification.
  report.verification.verified = completed.status === "COMPLETED";
  return { request: completed, report };
}

/** account:retry — re-run the purge for a PURGE_FAILED request. */
export async function retryDeletion(
  input: { id: string; actor: DeletionActor; confirmEmail: string },
  deps: DeletionDeps = defaultDeps,
) {
  const row = requireRequest(await getDeletionRequest(input.id), input.id);
  if (row.status !== "PURGE_FAILED") throw new DeletionError("WRONG_STATUS", `Only PURGE_FAILED can be retried (this one is ${row.status}).`);
  return deleteAccount({ ...input, acceptUnresolved: row.acceptedUnresolved?.steps ?? [], acceptReason: row.acceptedUnresolved?.reason ?? null }, deps);
}

/**
 * account:verify-storage — re-scan a request's prefix. Finishes AWAITING_SEAL
 * when the scan verifies; on a COMPLETED request, a non-empty prefix opens an
 * INTEGRITY_INCIDENT (late object). This is also the late-object detector.
 */
export async function verifyStorage(input: { id: string; actor: DeletionActor }, deps: DeletionDeps = defaultDeps) {
  const row = requireRequest(await getDeletionRequest(input.id), input.id);
  if (!["AWAITING_SEAL", "COMPLETED", "INTEGRITY_INCIDENT"].includes(row.status)) {
    throw new DeletionError("WRONG_STATUS", `Storage verification applies after the purge (this request is ${row.status}).`);
  }
  const store = deps.store();
  if (!store) throw new DeletionError("STORAGE_NOT_CONFIGURED", "Object storage is not configured in this environment; cannot scan.");
  const scan = await scanUserPrefix(store, row.userId, deps.now);
  // A human-run scan is always recorded; the hourly detector records only what
  // isn't clean, or every completed deletion would gain 24 audit rows a day.
  const clean = scan.complete && scan.objects === 0 && scan.uploads === 0;
  if (input.actor.type !== "SYSTEM" || !clean || row.status !== "COMPLETED") {
    await recordEvent(db, row.id, "STORAGE_SCAN", input.actor, { complete: scan.complete, objects: scan.objects, uploads: scan.uploads, error: scan.error ?? null });
  }

  if (scan.complete && (scan.objects > 0 || scan.uploads > 0)) {
    if (row.status === "COMPLETED") {
      const inc = await transition(db, row.id, "COMPLETED", "INTEGRITY_INCIDENT", input.actor, { lastError: `late objects found: ${scan.objects} objects, ${scan.uploads} uploads` }, { sampleKeys: scan.sampleKeys });
      return { request: inc, scan };
    }
    return { request: row, scan };
  }
  if (row.status === "AWAITING_SEAL" && scanVerifies(scan, row.tLast)) {
    const report = (row.report ?? {}) as unknown as DeletionReport;
    const done = await complete(row.id, scan.startedAt, report, deps, "AWAITING_SEAL");
    return { request: done, scan };
  }
  if (row.status === "COMPLETED" && scan.complete) {
    await db.update(accountDeletionRequest).set({ verifiedThrough: scan.startedAt }).where(eq(accountDeletionRequest.id, row.id));
  }
  return { request: requireRequest(await getDeletionRequest(row.id), row.id), scan };
}

/**
 * account:remediate — for an INTEGRITY_INCIDENT: purge the prefix again, then
 * the request waits in AWAITING_SEAL for a verifying scan.
 */
export async function remediateIncident(input: { id: string; actor: DeletionActor }, deps: DeletionDeps = defaultDeps) {
  const row = requireRequest(await getDeletionRequest(input.id), input.id);
  if (row.status !== "INTEGRITY_INCIDENT") throw new DeletionError("WRONG_STATUS", `Only an INTEGRITY_INCIDENT can be remediated (this one is ${row.status}).`);
  const store = deps.store();
  if (!store) throw new DeletionError("STORAGE_NOT_CONFIGURED", "Object storage is not configured in this environment.");
  const res = await purgeUserObjects(store, row.userId, []);
  await recordEvent(db, row.id, "INCIDENT_REPURGE", input.actor, { deleted: res.deleted, abortedUploads: res.abortedUploads, failures: res.failures.length });
  if (!res.complete) throw new DeletionError("REPURGE_INCOMPLETE", `Re-purge incomplete: ${res.failures.map((f) => `${f.key}: ${f.error}`).join("; ")}`);
  const next = await transition(db, row.id, "INTEGRITY_INCIDENT", "AWAITING_SEAL", input.actor, { tLast: new Date(deps.now().getTime() + T_LAST_MARGIN_MS) });
  return { request: next, purge: res };
}

/**
 * The completion transaction: COMPLETED, every request of this user minimised
 * (the COMPLETE-phase fields of the inventory), and those fields checked —
 * all or nothing. A failed check rolls the whole thing back and the request
 * goes to PURGE_FAILED with the check that failed; `account:retry` re-runs it.
 */
async function complete(id: string, verifiedThrough: Date, report: DeletionReport, deps: DeletionDeps, from: DeletionStatus = "VERIFYING"): Promise<DeletionRequestRow> {
  const row = requireRequest(await getDeletionRequest(id), id);
  // A request completing a second time (after an integrity incident) was
  // minimised the first time; there is no address left to check against.
  const ctx = row.email ? anonContext(row) : null;
  let done: DeletionRequestRow;
  try {
    done = await db.transaction(async (tx) => {
      const r = await transition(tx, id, from, "COMPLETED", { type: "SYSTEM" }, {
        completedAt: deps.now(),
        verifiedThrough,
        storageBlockMode: "LIFECYCLE_ONLY",
        lastError: null,
      });
      if (!ctx) {
        // Second completion: the marker was written the first time (if the
        // audit has since expired there is no hash left to write one from).
        if (row.emailHash) await insertMarker(tx, row, deps);
        return r;
      }
      const q = txQuery(tx);
      report.anonymised = { ...report.anonymised, ...(await anonymizeTenantRows(q, ctx, "COMPLETE")) };
      const checks = await anonymisationChecks(q, ctx, "COMPLETE");
      // The suppression marker exists only for a deletion that completes: it is
      // written here, in the transaction that marks it COMPLETED, and rolls back
      // with it.
      const markers = await insertMarker(tx, row, deps);
      checks.push({
        disposition: "RETAIN",
        table: "deletion_suppression",
        check: "deletion_suppression: exactly one marker for this request, written with the completion (intentional retention, not leftover)",
        found: markers === 1 ? 0 : 1,
        ok: markers === 1,
      });
      report.verification.checks = [...(report.verification.checks ?? []), ...checks];
      const bad = checks.filter((c) => !c.ok);
      if (bad.length) throw new MinimisationFailed(bad);
      await tx
        .update(accountDeletionRequest)
        .set({ minimisedAt: deps.now() })
        .where(and(eq(accountDeletionRequest.userId, row.userId), isNull(accountDeletionRequest.minimisedAt)));
      const [final] = await tx
        .update(accountDeletionRequest)
        .set({ report: report as unknown as Record<string, unknown> })
        .where(eq(accountDeletionRequest.id, id))
        .returning();
      return final!;
    });
  } catch (err) {
    // Any failure here — a check or the database — rolls back and ends
    // PURGE_FAILED, never stranded in VERIFYING: account:retry recovers it.
    report.verification.verified = false;
    const error =
      err instanceof MinimisationFailed
        ? `minimisation checks failed: ${err.checks.map((c) => `${c.check} (found ${c.found})`).join("; ")}`
        : `completion failed: ${errorText(err)}`;
    logger.error("[account-deletion] minimisation failed", { requestId: id, error });
    return transition(db, id, from, "PURGE_FAILED", { type: "SYSTEM" }, { lastError: error, report: report as unknown as Record<string, unknown> }, { error });
  }
  try {
    await deps.ledger().write({ requestId: id, userId: row.userId, emailHash: requireHash(row), event: "COMPLETED", fencedEpoch: row.fencedEpoch, at: deps.now().toISOString() });
    await recordEvent(db, id, "LEDGER_COMPLETED", { type: "SYSTEM" });
  } catch (err) {
    await recordEvent(db, id, "LEDGER_WRITE_FAILED", { type: "SYSTEM" }, { error: errorText(err) });
  }
  return done;
}

class MinimisationFailed extends Error {
  constructor(public readonly checks: VerificationCheck[]) {
    super("minimisation checks failed");
  }
}

function anonContext(row: DeletionRequestRow): AnonContext {
  if (!row.email) throw new DeletionError("NO_ADDRESS", `Request ${row.id} has no address on record; it cannot be anonymised against.`);
  return {
    userId: row.userId,
    email: row.email,
    emailHash: requireHash(row),
    kind: row.kind,
    tombstone: `former-member:${randomBytes(6).toString("hex")}`,
  };
}

/** The inventory's `$n` queries, run inside a drizzle transaction. */
function txQuery(tx: Tx): Query {
  return async (text, params) => {
    const parts = text.split(/\$(\d+)/);
    // sql.param, not sql`${v}`: the template expands an array into a tuple
    // ($1, $2), and the key list for STRIP_KEYS must bind as one text[].
    const chunks = parts.map((part, i) => (i % 2 === 0 ? sql.raw(part) : sql.param(params[Number(part) - 1])));
    const res = (await tx.execute(sql.join(chunks, sql.raw("")))) as unknown as { rows: Record<string, unknown>[]; rowCount?: number | null };
    return { rows: res.rows, rowCount: res.rowCount };
  };
}

/** Run `fn` in one pool transaction. */
async function inTransaction<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn((text, params) => client.query(text, params));
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verification by disposition, after the purge. The request's own rows are
 * checked later, in the completion transaction.
 */
async function dispositionChecks(row: DeletionRequestRow, remaining: Record<string, number>): Promise<VerificationCheck[]> {
  const ctx = anonContext(row);
  const leftover = Object.values(remaining).reduce((a, b) => a + b, 0);
  const checks: VerificationCheck[] = [
    { disposition: "DELETE", table: "(every DELETE table)", check: `zero rows for the user id in each of the ${PURGE_ORDER.length} DELETE tables`, found: leftover, ok: leftover === 0 },
    ...(await anonymisationChecks(poolQuery, ctx, "PURGE")),
    ...(await orgClosureChecks(poolQuery, ctx.email)),
  ];
  const billing = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM billing_event WHERE subject_type = 'USER' AND subject_id = $1`, [billingPseudonym(ctx.emailHash)]);
  const days = billingRetentionDays();
  checks.push({
    disposition: "RETAIN",
    table: "billing_event",
    check: `billing_event: ${billing.rows[0]?.n ?? 0} row(s) kept under the pseudonym; expiry ${days ? `after ${days} days (BILLING_RETENTION_DAYS)` : "none — BILLING_RETENTION_DAYS not configured"}`,
    found: 0,
    ok: true,
  });
  checks.push(...declarationChecks());
  return checks;
}

/**
 * Read the Google account id now — the `account` row holding it is purged in
 * the next step — and keep only its hash, on the request, for the completion
 * transaction to put in the suppression marker. Idempotent.
 */
async function captureGoogleIdentity(row: DeletionRequestRow): Promise<boolean> {
  const acct = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM "account" WHERE user_id = $1 AND provider_id = 'google' ORDER BY created_at LIMIT 1`,
    [row.userId],
  );
  const sub = acct.rows[0]?.account_id ?? null;
  if (!sub) return false;
  await db
    .update(accountDeletionRequest)
    .set({ googleSubHash: hashGoogleSub(sub) })
    .where(and(eq(accountDeletionRequest.id, row.id), isNull(accountDeletionRequest.googleSubHash)));
  return true;
}

/**
 * The suppression marker, inside the completion transaction: hashes only.
 * One per request (unique index); returns how many exist for it afterwards.
 */
async function insertMarker(tx: Tx, row: DeletionRequestRow, deps: DeletionDeps): Promise<number> {
  const now = deps.now();
  await tx
    .insert(deletionSuppression)
    .values({
      requestId: row.id,
      emailHash: requireHash(row),
      googleSubHash: row.googleSubHash,
      // Same clock as expiresAt, so the sweep's age and the marker's expiry agree.
      createdAt: now,
      expiresAt: new Date(now.getTime() + suppressionRetentionDays() * 24 * 60 * 60 * 1000),
    })
    .onConflictDoNothing();
  const [m] = await tx.select({ n: sql<number>`count(*)::int` }).from(deletionSuppression).where(eq(deletionSuppression.requestId, row.id));
  return Number(m?.n ?? 0);
}

async function purge(row: DeletionRequestRow, report: DeletionReport, deps: DeletionDeps, actor: DeletionActor): Promise<void> {
  const userId = row.userId;

  // 1. Storage first: the rows below are how we know which keys exist.
  const store = deps.store();
  if (!store) {
    report.storage = { error: "object storage not configured in this environment" };
    throw new Error("object storage is not configured here (OBJECT_STORAGE_* missing); refusing to report storage as deleted");
  }
  const recorded = await db
    .select({ key: messageAttachments.cacheStorageKey })
    .from(messageAttachments)
    .where(and(eq(messageAttachments.userId, userId), isNotNull(messageAttachments.cacheStorageKey)));
  const sres = await purgeUserObjects(store, userId, recorded.map((r) => r.key!).filter(Boolean));
  report.storage = sres;
  await recordEvent(db, row.id, "STORAGE_PURGED", { type: "SYSTEM" }, { deleted: sres.deleted, abortedUploads: sres.abortedUploads, failures: sres.failures.length, complete: sres.complete });
  if (!sres.complete) {
    throw new Error(`storage purge incomplete: ${sres.failures.slice(0, 10).map((f) => `${f.key}: ${f.error}`).join("; ")}`);
  }

  // 2. Organization membership (non-last-owner orgs; last-owner orgs were resolved at fence).
  const email = row.email;
  if (email) {
    const memberships = await db
      .select({ orgId: orgMembership.organizationId })
      .from(orgMembership)
      .where(and(eq(orgMembership.email, normalizeOrgEmail(email)), isNull(orgMembership.effectiveUntil)));
    for (const m of memberships) {
      await removeMember({ organizationId: m.orgId, email, actorUserId: actor.type === "SYSTEM" ? userId : actor.userId });
    }
    report.rowsDeleted.org_memberships_closed = memberships.length;
  }

  // 3. The Google account id for the suppression marker, while it is still on
  //    file. The marker itself is written only by the completion transaction.
  const captured = await captureGoogleIdentity(row);
  await recordEvent(db, row.id, "GOOGLE_IDENTITY_CAPTURED", { type: "SYSTEM" }, { captured });

  // 4. Anonymise what is kept: the inventory's PURGE-phase fields, all in one
  //    transaction so an organization's history is never half-tombstoned.
  const ctx = anonContext(row);
  report.anonymised = await inTransaction((q) => anonymizeTenantRows(q, ctx, "PURGE"));
  report.retention = retentionRecords();
  report.retained = [
    ...report.retention.map((r) => `${r.table} (${r.disposition}): ${r.purpose} Period: ${r.period}`),
    row.kind === "PRIVACY_ERASURE"
      ? "Organization history: the member's address was replaced by a former-member tombstone (PRIVACY_ERASURE); dates, roles and reporting shape stay."
      : "Organization history: closed membership, reporting and audit rows keep the member's address as the organization's record (DEPARTURE).",
  ];

  // 5. Database, table by table, batched so no single statement runs long.
  Object.assign(report.rowsDeleted, await purgeTenantRows(poolQuery, userId));
  await recordEvent(db, row.id, "DATABASE_PURGED", { type: "SYSTEM" }, { tables: Object.keys(report.rowsDeleted).length, rows: Object.values(report.rowsDeleted).reduce((a, b) => a + b, 0) });

  // 6. Caches.
  invalidateMailboxCache(userId);
  __resetPauseMemo();
}

const poolQuery: Query = (text, params) => pool.query(text, params);

function actorLabel(a: DeletionActor): string {
  return a.type === "SYSTEM" ? "system" : a.email;
}

function errorText(err: unknown): string {
  // The stack already begins with "Name: message". Drizzle wraps a database
  // error as "Failed query: …" and keeps Postgres's own message in `cause`,
  // so the cause chain is part of the document.
  if (err instanceof Error) {
    const own = withoutBoundValues(err.stack ?? `${err.name}: ${err.message}`);
    return err.cause !== undefined ? `${own}\nCaused by: ${errorText(err.cause)}` : own;
  }
  return withoutBoundValues(String(err));
}

/**
 * Drizzle appends the bound values to "Failed query: …" as a `params:` line.
 * Those are data, not diagnosis — here they are the user's address and id —
 * and this text is stored on the request and written to the log. The SQL and
 * the database's own error stay; the values go.
 */
export function withoutBoundValues(text: string): string {
  return text.replace(/^params: .*$/gm, "params: [withheld]");
}

/** Resolve a developer actor from an email, refusing anyone without the role. */
export async function developerActor(email: string): Promise<DeletionActor> {
  const [u] = await db
    .select({ id: user.id, email: user.email, role: user.platformRole })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email.trim().toLowerCase()))
    .limit(1);
  if (!u) throw new DeletionError("NOT_FOUND", `No user ${email}.`);
  if (u.role !== "DEVELOPER") throw new DeletionError("FORBIDDEN", `${email} is not a DEVELOPER.`);
  return { type: "DEVELOPER", userId: u.id, email: u.email };
}

// ── Legal hold ────────────────────────────────────────────────────────

/**
 * account:hold. Stops every retention expiry tied to this request — its audit,
 * its suppression marker, its billing rows, the job runs against its account —
 * until released. It changes nothing else: a hold does not pause a deletion.
 */
export async function setLegalHold(input: { id: string; actor: DeletionActor; reason: string }): Promise<DeletionRequestRow> {
  if (input.actor.type !== "DEVELOPER") throw new DeletionError("FORBIDDEN", "Only a developer can place a legal hold.");
  const reason = input.reason.trim();
  if (reason.length < 3) throw new DeletionError("REASON_REQUIRED", "A legal hold needs a reason.");
  const row = requireRequest(await getDeletionRequest(input.id), input.id);
  if (row.legalHoldAt) throw new DeletionError("ALREADY_HELD", `Request ${row.id} is already under a legal hold since ${row.legalHoldAt.toISOString()}.`);
  return db.transaction(async (tx) => {
    const [r] = await tx
      .update(accountDeletionRequest)
      .set({ legalHoldReason: reason, legalHoldAt: new Date(), legalHoldBy: actorLabel(input.actor) })
      .where(and(eq(accountDeletionRequest.id, row.id), isNull(accountDeletionRequest.legalHoldAt)))
      .returning();
    if (!r) throw new DeletionError("CONFLICT", `Request ${row.id} changed while placing the hold; reload and retry.`);
    await recordEvent(tx, row.id, "LEGAL_HOLD_SET", input.actor, { reason });
    return r;
  });
}

/** account:hold --release. The retention clock was never paused, so expiry may be due at once. */
export async function releaseLegalHold(input: { id: string; actor: DeletionActor; reason: string }): Promise<DeletionRequestRow> {
  if (input.actor.type !== "DEVELOPER") throw new DeletionError("FORBIDDEN", "Only a developer can release a legal hold.");
  const reason = input.reason.trim();
  if (reason.length < 3) throw new DeletionError("REASON_REQUIRED", "Releasing a legal hold needs a reason.");
  const row = requireRequest(await getDeletionRequest(input.id), input.id);
  if (!row.legalHoldAt) throw new DeletionError("NOT_HELD", `Request ${row.id} is not under a legal hold.`);
  return db.transaction(async (tx) => {
    const [r] = await tx
      .update(accountDeletionRequest)
      .set({ legalHoldReason: null, legalHoldAt: null, legalHoldBy: null })
      .where(eq(accountDeletionRequest.id, row.id))
      .returning();
    await recordEvent(tx, row.id, "LEGAL_HOLD_RELEASED", input.actor, { reason, heldSince: row.legalHoldAt!.toISOString(), heldFor: row.legalHoldReason });
    return r!;
  });
}

// ── Re-registration review ────────────────────────────────────────────

export interface ReregistrationReviewRow {
  id: string;
  status: "OPEN" | "RESOLVED";
  matchedOn: "GOOGLE_ACCOUNT" | "EMAIL" | "GOOGLE_ACCOUNT_AND_EMAIL";
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  /** The NEW account — a live user, shown so the developer knows who it is. */
  newUserId: string;
  newUserEmail: string | null;
  newUserCreatedAt: Date | null;
  /** The deletion it matched: outcome and dates only, never the old address. */
  deletedRequestId: string;
  deletedKind: "DEPARTURE" | "PRIVACY_ERASURE";
  deletedStatus: DeletionStatus;
  deletedCompletedAt: Date | null;
}

export async function listReregistrationReviews(opts: { includeResolved?: boolean; id?: string } = {}): Promise<ReregistrationReviewRow[]> {
  const q = db
    .select({
      id: deletionReregistrationReview.id,
      status: deletionReregistrationReview.status,
      matchedOn: deletionReregistrationReview.matchedOn,
      createdAt: deletionReregistrationReview.createdAt,
      resolvedAt: deletionReregistrationReview.resolvedAt,
      resolvedBy: deletionReregistrationReview.resolvedBy,
      resolutionNote: deletionReregistrationReview.resolutionNote,
      newUserId: deletionReregistrationReview.newUserId,
      newUserEmail: user.email,
      newUserCreatedAt: user.createdAt,
      deletedRequestId: accountDeletionRequest.id,
      deletedKind: accountDeletionRequest.kind,
      deletedStatus: accountDeletionRequest.status,
      deletedCompletedAt: accountDeletionRequest.completedAt,
    })
    .from(deletionReregistrationReview)
    .innerJoin(deletionSuppression, eq(deletionSuppression.id, deletionReregistrationReview.suppressionId))
    .innerJoin(accountDeletionRequest, eq(accountDeletionRequest.id, deletionSuppression.requestId))
    .leftJoin(user, eq(user.id, deletionReregistrationReview.newUserId));
  const where = opts.id
    ? eq(deletionReregistrationReview.id, opts.id)
    : opts.includeResolved
      ? undefined
      : eq(deletionReregistrationReview.status, "OPEN");
  const rows = await q.where(where).orderBy(desc(deletionReregistrationReview.createdAt)).limit(200);
  return rows as ReregistrationReviewRow[];
}

/**
 * Close a review with what the developer concluded. Resolving changes nothing
 * about the new account: there is no block to lift and nothing to restore.
 */
export async function resolveReregistrationReview(input: { id: string; actor: DeletionActor; note: string }): Promise<ReregistrationReviewRow> {
  if (input.actor.type !== "DEVELOPER") throw new DeletionError("FORBIDDEN", "Only a developer can resolve a re-registration review.");
  const note = input.note.trim();
  if (note.length < 3) throw new DeletionError("REASON_REQUIRED", "Say what you concluded.");
  const [r] = await db
    .update(deletionReregistrationReview)
    .set({ status: "RESOLVED", resolutionNote: note, resolvedBy: actorLabel(input.actor), resolvedAt: new Date() })
    .where(and(eq(deletionReregistrationReview.id, input.id), eq(deletionReregistrationReview.status, "OPEN")))
    .returning({ id: deletionReregistrationReview.id });
  if (!r) throw new DeletionError("NOT_FOUND", `No open re-registration review ${input.id}.`);
  const [resolved] = await listReregistrationReviews({ id: r.id });
  return resolved!;
}
