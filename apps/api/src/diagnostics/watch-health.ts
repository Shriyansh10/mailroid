import { db } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";

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
}

export interface WatchHealthReport {
  checkedAt: string;
  gmail: WatchHealthBucket;
  calendar: WatchHealthBucket;
  // Live cooldown/failure state per mailbox, inspectable without a psql
  // session — the columns quota-cooldown.ts writes but nothing surfaced
  // before this. Only mailboxes with something to report are included.
  gmailCooldowns: GmailCooldownStatus[];
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
  const [gmailRows, calendarRows, cooldownRows] = await Promise.all([
    db.select({ watchExpiration: gmailTenantMappings.watchExpiration }).from(gmailTenantMappings),
    db.select({ watchExpiration: calendarTenantMappings.watchExpiration }).from(calendarTenantMappings),
    db
      .select({
        emailAddress: gmailTenantMappings.emailAddress,
        tenantId: gmailTenantMappings.tenantId,
        quotaCooldownUntil: gmailTenantMappings.quotaCooldownUntil,
        quotaCooldownReason: gmailTenantMappings.quotaCooldownReason,
        quotaResumeFailures: gmailTenantMappings.quotaResumeFailures,
        quotaCooldownStartedAt: gmailTenantMappings.quotaCooldownStartedAt,
        lastWebhookFailureAt: gmailTenantMappings.lastWebhookFailureAt,
        lastWebhookFailureReason: gmailTenantMappings.lastWebhookFailureReason,
      })
      .from(gmailTenantMappings),
  ]);

  const now = Date.now();
  const gmailCooldowns: GmailCooldownStatus[] = cooldownRows
    .filter(
      (r) =>
        r.quotaResumeFailures > 0 ||
        r.quotaCooldownUntil !== null ||
        r.lastWebhookFailureAt !== null,
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
    }));

  return {
    checkedAt: new Date().toISOString(),
    gmail: bucket(gmailRows.map((r) => r.watchExpiration)),
    calendar: bucket(calendarRows.map((r) => r.watchExpiration)),
    gmailCooldowns,
  };
}
