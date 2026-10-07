/**
 * Re-register the Gmail push watch for a mailbox.
 *
 * WHY A MANUAL JOB EXISTS AT ALL. A watch expires 7 days after registration and
 * renewal is on the critical path — a mailbox whose watch lapses stops being
 * told anything ever happened, silently. The daily cron handles the normal
 * case, but the cron runs inside the app, and the whole point of the external
 * schedule is that renewal must not depend on this server being healthy. This
 * job is the recovery handle for when it hasn't been.
 *
 * ONLY WHAT NEEDS IT, BY DEFAULT. `users.watch` costs 100 quota units — the
 * most expensive call in the catalogue — so "renew for every user" across a
 * large install would cost 100 x N for mailboxes that are mostly fine. The same
 * 48-hour threshold the cron uses decides who is renewed; everyone else is
 * recorded as skipped, with the expiry that made them skippable, so the run is
 * cheap and safe to repeat.
 *
 * OWNERSHIP IS NOT CHECKED HERE. `startGmailWatch` refuses a mailbox this
 * environment does not own, and that refusal is the real guard — Gmail keeps
 * exactly ONE watch per mailbox, so renewing someone else's silently repoints
 * their notifications here and leaves the true owner deaf. Re-implementing that
 * check in a second place would risk the two disagreeing.
 */

import { db, eq } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";

import { startGmailWatch } from "../gmail/watch.ts";
import { getAuthFailure } from "../gmail/quota-cooldown.ts";

/** `users.watch` — by some distance the priciest call we make. */
export const WATCH_UNITS = 100;

/**
 * Matches gmailWatchCron. Deliberately the same number: a manual run and the
 * scheduled run disagreeing about who needs renewing would make the audit trail
 * impossible to reason about.
 */
const RENEW_WITHIN_MS = 2 * 24 * 60 * 60 * 1000;

interface WatchState {
  email: string | null;
  expiration: Date | null;
  needsRenewal: boolean;
}

async function readWatchState(userId: string): Promise<WatchState | null> {
  const [row] = await db
    .select({
      email: gmailTenantMappings.emailAddress,
      expiration: gmailTenantMappings.watchExpiration,
    })
    .from(gmailTenantMappings)
    .where(eq(gmailTenantMappings.tenantId, userId))
    .limit(1);

  if (!row) return null;

  // A null expiry means no watch has ever been registered, which needs renewal
  // just as much as a lapsed one — and is the easier case to overlook.
  const needsRenewal =
    row.expiration === null || row.expiration.getTime() < Date.now() + RENEW_WITHIN_MS;

  return { email: row.email, expiration: row.expiration, needsRenewal };
}

export async function estimateWatchRenewal(
  userId: string,
): Promise<{ rows: number; units: number; note?: string }> {
  // Said at estimate time, not discovered at run time. A renewal cannot work
  // without live credentials, and reconnecting — the only fix — re-registers
  // the watch by itself, so for this mailbox the job has nothing to add.
  const authFailure = await getAuthFailure(userId);
  if (authFailure) {
    return {
      rows: 0,
      units: 0,
      note: `Credentials lapsed ${authFailure.at.toISOString()}. This mailbox needs the user to reconnect Gmail, which re-registers the watch on its own — renewing from here cannot work and will be skipped.`,
    };
  }

  const state = await readWatchState(userId);

  if (!state) {
    return { rows: 0, units: 0, note: "No Gmail mapping for this tenant — nothing to renew." };
  }

  if (!state.needsRenewal) {
    return {
      rows: 0,
      units: 0,
      note: `Watch is healthy until ${state.expiration?.toISOString() ?? "unknown"} — it will be skipped.`,
    };
  }

  return {
    rows: 1,
    units: WATCH_UNITS,
    note: state.expiration
      ? `Watch expires ${state.expiration.toISOString()} — inside the 48h renewal window.`
      : "No watch has ever been registered for this mailbox.",
  };
}

export interface WatchRenewalResult {
  processed: number;
  succeeded: number;
  failed: number;
  details: Record<string, unknown>;
  errors: string[];
}

export async function runWatchRenewal(
  userId: string,
  opts: { dryRun?: boolean } = {},
): Promise<WatchRenewalResult> {
  const state = await readWatchState(userId);

  if (!state) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      details: { skipped: true, reason: "no-mapping" },
      errors: [],
    };
  }

  if (!state.needsRenewal) {
    return {
      processed: 1,
      succeeded: 0,
      failed: 0,
      details: {
        skipped: true,
        reason: "not-due",
        expiresAt: state.expiration?.toISOString() ?? null,
      },
      errors: [],
    };
  }

  if (opts.dryRun) {
    return {
      processed: 1,
      succeeded: 0,
      failed: 0,
      details: {
        wouldRenew: true,
        expiresAt: state.expiration?.toISOString() ?? null,
      },
      errors: [],
    };
  }

  try {
    await startGmailWatch(userId);
    const after = await readWatchState(userId);
    return {
      processed: 1,
      succeeded: 1,
      failed: 0,
      details: { renewed: true, expiresAt: after?.expiration?.toISOString() ?? null },
      errors: [],
    };
  } catch (err) {
    // Reported, not thrown: in an all-users fan-out one refused mailbox — a
    // dead token, or one this environment does not own — must not take the
    // sweep down with it. The audit row carries the reason.
    const message = err instanceof Error ? err.message : String(err);
    return {
      processed: 1,
      succeeded: 0,
      failed: 1,
      details: { renewed: false },
      errors: [message],
    };
  }
}
