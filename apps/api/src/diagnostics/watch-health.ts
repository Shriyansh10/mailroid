import { db } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { syncPauses } from "@repo/database/models/sync-pauses";

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
        r.lastWebhookFailureAt !== null ||
        // An auth-dead mailbox can have entirely clean quota columns — that is
        // the whole point of the split — so it needs its own clause or it
        // would be invisible here, which is how the incident stayed unexplained.
        r.gmailAuthFailedAt !== null,
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
  };
}
