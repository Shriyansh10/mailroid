import { db } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { syncPauses } from "@repo/database/models/sync-pauses";
import { mailroidEnv } from "@repo/services/env.js";
import { isWebhookMarkerActionable } from "@repo/services/gmail/webhook-push.js";
import { unmappedPushSnapshot, type UnmappedPushSnapshot } from "./unmapped-push-counter.js";

const RENEW_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000; // 48h — matches the watch crons

export interface WatchHealthBucket {
  total: number;
  healthy: number; // expires > now + 48h
  expiringSoon: number; // now < expires <= now + 48h (renewal window)
  expired: number; // expires <= now — NOT delivering
  missing: number; // no expiration recorded — never registered / unknown
  soonestExpiration: string | null;
}

export interface GmailCooldownStatus {
  emailAddress: string;
  tenantId: string;
  quotaCooldownUntil: string | null;
  quotaCooldownReason: string | null;
  quotaResumeFailures: number;
  quotaCooldownStartedAt: string | null;
  blockedForMs: number | null;
  lastWebhookFailureAt: string | null;
  lastWebhookFailureReason: string | null;
  /**
   * Authentication is a separate failure mode from quota — see
   * gmail-tenant-mappings.ts. A set value means corsair attempted a token
   * refresh and it failed, so the mailbox is making no Gmail calls at all.
   * Unlike a cooldown this does NOT lapse on its own: it clears only when a
   * Gmail call succeeds, so it needs an operator, not patience.
   */
  gmailAuthFailedAt: string | null;
  gmailAuthFailureReason: string | null;
  /** P-2/P-9, docs/gmail-rate-limit-boundary.md §13 — see `orphans` below. */
  watchTopic: string | null;
  watchOwnerEnv: string | null;
  /**
   * P-3, docs/gmail-rate-limit-boundary.md §13. Set when a webhook diff hit a
   * 404 (history retention window passed) instead of firing an automatic full
   * sync. True here means this mailbox needs a DELIBERATE, budgeted resync —
   * `pnpm admin gmail:resync <mailbox>` — not that anything is actively wrong
   * right now; the mailbox keeps receiving new mail via its (correctly
   * advanced) cursor in the meantime, it just missed whatever changed inside
   * the unrecoverable window.
   */
  resyncRequired: boolean;
  resyncRequiredAt: string | null;
}

/**
 * A mapping this environment's own database holds, whose recorded
 * `watchOwnerEnv` names a DIFFERENT environment than the one running this
 * query — the detector of last resort for P-1's residual risk. Local and
 * production run separate databases (that's the whole reason the allowlist
 * has to be config, not a shared table), so neither side can see the other's
 * claim directly; this is what "the mailbox got reconnected here after
 * MAILROID_ENV or the allowlist changed underneath it" looks like from the
 * inside — a stale ownership marker on a row THIS process still holds.
 *
 * A `null` watchOwnerEnv is NOT an orphan: it means no watch has been
 * (re-)registered since P-2 shipped the column, which `missing` in the
 * bucket above already surfaces.
 */
export interface WatchOrphan {
  emailAddress: string;
  tenantId: string;
  watchTopic: string | null;
  watchOwnerEnv: string;
  thisEnvironment: string;
}

export interface ActivePauseStatus {
  scope: string;
  tenantId: string | null;
  mode: string;
  reason: string | null;
  createdBy: string | null;
  blockWatchRenewal: boolean;
  createdAt: string;
  expiresAt: string | null;
  /**
   * True when this pause blocks watch renewal AND that mailbox's watch is
   * inside the 48h renewal window. That combination is the one way a pause
   * turns into an unrecoverable-without-re-registration problem, so it is
   * called out rather than left to be inferred from two other fields.
   */
  watchAtRisk: boolean;
}

export interface WatchHealthReport {
  checkedAt: string;
  gmail: WatchHealthBucket;
  calendar: WatchHealthBucket;
  // Live cooldown/failure state per mailbox, inspectable without a psql
  // session — the columns quota-cooldown.ts writes but nothing surfaced
  // before this. Only mailboxes with something to report are included.
  gmailCooldowns: GmailCooldownStatus[];
  // Active operator pauses. A mailbox that is "not syncing" is far more often
  // paused on purpose than broken, and without this the two look identical.
  activePauses: ActivePauseStatus[];
  // P-9: answers U-1 permanently, without a tunnel — see WatchOrphan above.
  orphans: WatchOrphan[];
  // P-2: the countable replacement for the unmapped-push `warn` that used to
  // scroll past. Non-zero since boot means Gmail is pushing for a mailbox
  // this process cannot resolve — the exact shape of §9.2's incident.
  unmappedPushes: UnmappedPushSnapshot;
}

function bucket(expirations: Array<Date | null>): WatchHealthBucket {
  const now = Date.now();
  const b: WatchHealthBucket = {
    total: expirations.length,
    healthy: 0,
    expiringSoon: 0,
    expired: 0,
    missing: 0,
    soonestExpiration: null,
  };
  let soonest: number | null = null;

  for (const exp of expirations) {
    if (!exp) {
      b.missing += 1;
      continue;
    }
    const ms = exp.getTime();
    if (soonest === null || ms < soonest) soonest = ms;

    if (ms <= now) b.expired += 1;
    else if (ms <= now + RENEW_THRESHOLD_MS) b.expiringSoon += 1;
    else b.healthy += 1;
  }

  b.soonestExpiration = soonest === null ? null : new Date(soonest).toISOString();
  return b;
}

/**
 * Snapshot of watch health across both integrations. Surfaces the silent
 * failure mode that's bitten this project: a watch that has expired (or was
 * never registered) stops Google from delivering, with nothing else to signal
 * it. `expired > 0` or a large `missing` count means notifications are (partly)
 * dark. Reads only expiration columns — no credentials touched.
 */
export async function getWatchHealth(): Promise<WatchHealthReport> {
  const [gmailRows, calendarRows, cooldownRows, pauseRows] = await Promise.all([
    db.select({ watchExpiration: gmailTenantMappings.watchExpiration }).from(gmailTenantMappings),
    db.select({ watchExpiration: calendarTenantMappings.watchExpiration }).from(calendarTenantMappings),
    db
      .select({
        emailAddress: gmailTenantMappings.emailAddress,
        tenantId: gmailTenantMappings.tenantId,
        watchExpiration: gmailTenantMappings.watchExpiration,
        quotaCooldownUntil: gmailTenantMappings.quotaCooldownUntil,
        quotaCooldownReason: gmailTenantMappings.quotaCooldownReason,
        quotaResumeFailures: gmailTenantMappings.quotaResumeFailures,
        quotaCooldownStartedAt: gmailTenantMappings.quotaCooldownStartedAt,
        lastWebhookFailureAt: gmailTenantMappings.lastWebhookFailureAt,
        lastWebhookFailureReason: gmailTenantMappings.lastWebhookFailureReason,
        gmailAuthFailedAt: gmailTenantMappings.gmailAuthFailedAt,
        gmailAuthFailureReason: gmailTenantMappings.gmailAuthFailureReason,
        watchTopic: gmailTenantMappings.watchTopic,
        watchOwnerEnv: gmailTenantMappings.watchOwnerEnv,
        resyncRequired: gmailTenantMappings.resyncRequired,
        resyncRequiredAt: gmailTenantMappings.resyncRequiredAt,
      })
      .from(gmailTenantMappings),
    db.select().from(syncPauses),
  ]);

  const now = Date.now();
  const gmailCooldowns: GmailCooldownStatus[] = cooldownRows
    .filter(
      (r) =>
        r.quotaResumeFailures > 0 ||
        r.quotaCooldownUntil !== null ||
        // A fresh IN_FLIGHT marker is written on every dispatched delivery and
        // is not a finding until it outlives its window — see webhook-push.ts.
        isWebhookMarkerActionable(r.lastWebhookFailureAt, r.lastWebhookFailureReason, now) ||
        // An auth-dead mailbox can have entirely clean quota columns — that is
        // the whole point of the split — so it needs its own clause or it
        // would be invisible here, which is how the incident stayed unexplained.
        r.gmailAuthFailedAt !== null ||
        // P-3: a mailbox waiting on a deliberate resync is worth seeing here
        // too, even though nothing about it is actively broken.
        r.resyncRequired,
    )
    .map((r) => ({
      emailAddress: r.emailAddress,
      tenantId: r.tenantId,
      quotaCooldownUntil: r.quotaCooldownUntil?.toISOString() ?? null,
      quotaCooldownReason: r.quotaCooldownReason,
      quotaResumeFailures: r.quotaResumeFailures,
      quotaCooldownStartedAt: r.quotaCooldownStartedAt?.toISOString() ?? null,
      blockedForMs: r.quotaCooldownStartedAt ? now - r.quotaCooldownStartedAt.getTime() : null,
      lastWebhookFailureAt: r.lastWebhookFailureAt?.toISOString() ?? null,
      lastWebhookFailureReason: r.lastWebhookFailureReason,
      gmailAuthFailedAt: r.gmailAuthFailedAt?.toISOString() ?? null,
      gmailAuthFailureReason: r.gmailAuthFailureReason,
      watchTopic: r.watchTopic,
      watchOwnerEnv: r.watchOwnerEnv,
      resyncRequired: r.resyncRequired,
      resyncRequiredAt: r.resyncRequiredAt?.toISOString() ?? null,
    }));

  // P-9 orphan detection — see WatchOrphan's doc comment. A null
  // watchOwnerEnv (no watch registered since P-2) is excluded on purpose:
  // that is "missing", not "wrong owner", and the bucket above already
  // reports it.
  const orphans: WatchOrphan[] = cooldownRows
    .filter((r) => r.watchOwnerEnv !== null && r.watchOwnerEnv !== mailroidEnv.env)
    .map((r) => ({
      emailAddress: r.emailAddress,
      tenantId: r.tenantId,
      watchTopic: r.watchTopic,
      watchOwnerEnv: r.watchOwnerEnv as string,
      thisEnvironment: mailroidEnv.env,
    }));

  const watchExpiryByTenant = new Map(
    cooldownRows.map((r) => [r.tenantId, r.watchExpiration]),
  );

  const activePauses: ActivePauseStatus[] = pauseRows
    .filter((p) => p.expiresAt === null || p.expiresAt.getTime() > now)
    .map((p) => {
      const watchExpiration = p.tenantId
        ? (watchExpiryByTenant.get(p.tenantId) ?? null)
        : null;
      return {
        scope: p.scope,
        tenantId: p.tenantId,
        mode: p.mode,
        reason: p.reason,
        createdBy: p.createdBy,
        blockWatchRenewal: p.blockWatchRenewal,
        createdAt: p.createdAt.toISOString(),
        expiresAt: p.expiresAt?.toISOString() ?? null,
        watchAtRisk:
          p.blockWatchRenewal &&
          watchExpiration !== null &&
          watchExpiration.getTime() <= now + RENEW_THRESHOLD_MS,
      };
    });

  return {
    checkedAt: new Date().toISOString(),
    gmail: bucket(gmailRows.map((r) => r.watchExpiration)),
    calendar: bucket(calendarRows.map((r) => r.watchExpiration)),
    gmailCooldowns,
    activePauses,
    orphans,
    unmappedPushes: unmappedPushSnapshot(),
  };
}
