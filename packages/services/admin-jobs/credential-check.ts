/**
 * Refresh and verify Gmail + Calendar credentials for a mailbox.
 *
 * WHAT THIS CANNOT DO, SAID FIRST. It cannot renew a refresh token. Only the
 * user re-consenting through Google can do that, and no server-side action
 * substitutes for it. A grant Google has revoked (`invalid_grant`) is dead
 * until its owner reconnects, and any tool claiming otherwise is lying.
 *
 * WHAT IT ACTUALLY DOES, which is the useful part:
 *
 *   1. Forces an ACCESS token refresh on both services. Access tokens expire
 *      hourly and are refreshed from the stored refresh token — that is
 *      server-side work, and it is what keeps a mailbox usable.
 *   2. Clears a stuck auth latch. A successful call is the evidence that
 *      `clearGmailAuthLatch` needs, so a mailbox gated by a stale AUTH_FAILED
 *      after its credentials were already repaired is freed by running this.
 *      That deadlock is the reason this job earns its place.
 *   3. Tells you, per mailbox and for both services separately, who is healthy
 *      and who needs their owner to reconnect — in one sweep, instead of
 *      discovering it one failed job at a time.
 *
 * Gmail and Calendar are checked independently on purpose: they are separate
 * OAuth grants through separate Corsair plugins, and one can lapse while the
 * other is fine. Reporting a single "broken" verdict would hide which of the
 * two the user actually needs to reconnect.
 */

import { corsair } from "@repo/corsair";

import { gmailRequestWithAuthRecovery } from "../gmail/gmail-request.ts";
import { classifyGmailFailure } from "../gmail/gmail-errors.ts";

/** `users.getProfile` — the cheapest authenticated Gmail call there is. */
export const PROFILE_UNITS = 1;

export type ServiceHealth = "ok" | "needs-reconnect" | "error" | "not-connected";

export interface CredentialCheckDetails extends Record<string, unknown> {
  gmail: ServiceHealth;
  calendar: ServiceHealth;
  gmailError?: string;
  calendarError?: string;
}

/**
 * Calendar's counterpart to `classifyGmailFailure`.
 *
 * That function cannot be reused here: its CORSAIR_AUTH_FAILURE regex is
 * hard-coded to `[corsair:gmail]` and `[auth-missing:gmail`, so a Calendar
 * auth failure falls through it and is reported as a generic error — which
 * would send the operator looking for a Calendar bug when the real answer is
 * "the user must reconnect Calendar". Mirrored rather than generalised so a
 * change to Gmail's classifier cannot silently alter Calendar's verdict.
 * Re-check both on a corsair version bump.
 */
const CALENDAR_AUTH_FAILURE =
  /\[corsair:googlecalendar\] Failed to obtain valid access token|\[auth-missing:googlecalendar|AuthMissingError|invalid_grant/i;

function isCalendarAuthFailure(err: unknown): boolean {
  const text = err instanceof Error ? (err.message ?? "") : String(err);
  if (CALENDAR_AUTH_FAILURE.test(text)) return true;
  // A freshly refreshed token that Google still rejects is a dead grant too.
  return (err as { status?: number })?.status === 401;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function checkGmail(
  userId: string,
): Promise<{ health: ServiceHealth; error?: string }> {
  try {
    // Routed through the auth-recovery path deliberately: it refreshes on a
    // 401 and, on success, clears the auth latch. Using a gated call instead
    // would be refused by the very latch this is meant to lift.
    const res = await gmailRequestWithAuthRecovery(
      userId,
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { ctx: { trigger: "ui", operation: "users.getProfile", targetId: userId } },
    );
    if (res.ok) return { health: "ok" };
    return { health: "error", error: `HTTP ${res.status}` };
  } catch (err) {
    // The repo's own classifier, not a substring match: it understands
    // corsair's wording, bare 401s, and a 403 carrying an OAuth invalidity
    // marker, and it deliberately does NOT treat a 429 with incidental auth
    // wording as auth-dead.
    if (classifyGmailFailure(err) === "auth") {
      return { health: "needs-reconnect", error: describe(err) };
    }
    return { health: "error", error: describe(err) };
  }
}

async function checkCalendar(
  userId: string,
): Promise<{ health: ServiceHealth; error?: string }> {
  try {
    // The same one-event probe calendar/watch.ts uses to force a refresh.
    await corsair.withTenant(userId).googlecalendar.api.events.getMany({ maxResults: 1 });
    return { health: "ok" };
  } catch (err) {
    if (isCalendarAuthFailure(err)) {
      return { health: "needs-reconnect", error: describe(err) };
    }
    // A mailbox that never connected Calendar is not broken, it is just not
    // connected — reporting that as an error would send someone chasing a
    // fault that does not exist.
    const message = describe(err);
    if (/no .*(token|connection|tenant)/i.test(message)) {
      return { health: "not-connected", error: message };
    }
    return { health: "error", error: message };
  }
}

export async function estimateCredentialCheck(): Promise<{
  rows: number;
  units: number;
  note?: string;
}> {
  return {
    rows: 1,
    units: PROFILE_UNITS,
    note: "One Gmail profile read (1 unit) and one Calendar list read per mailbox. Refreshes access tokens and clears a stuck auth latch. It cannot revive a revoked grant — only the user reconnecting can do that.",
  };
}

export interface CredentialCheckResult {
  processed: number;
  succeeded: number;
  failed: number;
  details: CredentialCheckDetails;
  errors: string[];
}

export async function runCredentialCheck(
  userId: string,
  opts: { dryRun?: boolean } = {},
): Promise<CredentialCheckResult> {
  if (opts.dryRun) {
    return {
      processed: 1,
      succeeded: 0,
      failed: 0,
      details: {
        gmail: "ok",
        calendar: "ok",
        note: "Dry run: no calls were made, so nothing was verified or refreshed.",
      } as CredentialCheckDetails,
      errors: [],
    };
  }

  // Sequential, not parallel. Two services on one mailbox share a token store,
  // and the saving from overlapping two sub-second calls is not worth racing
  // two refreshes against each other.
  const gmail = await checkGmail(userId);
  const calendar = await checkCalendar(userId);

  const details: CredentialCheckDetails = {
    gmail: gmail.health,
    calendar: calendar.health,
    ...(gmail.error ? { gmailError: gmail.error } : {}),
    ...(calendar.error ? { calendarError: calendar.error } : {}),
  };

  const needsReconnect = [
    gmail.health === "needs-reconnect" ? "Gmail" : null,
    calendar.health === "needs-reconnect" ? "Calendar" : null,
  ].filter(Boolean);

  if (needsReconnect.length > 0) {
    details.message = `${needsReconnect.join(" and ")} ${needsReconnect.length === 1 ? "has" : "have"} a revoked or expired grant. The user must reconnect ${needsReconnect.length === 1 ? "it" : "them"} in Settings → Connections. No admin action can restore this.`;
  }

  const healthy = gmail.health === "ok" && calendar.health !== "needs-reconnect";

  return {
    processed: 1,
    // "Succeeded" means the mailbox is usable afterwards, not that the job ran.
    // A clean run that proves a mailbox is dead has not succeeded at anything
    // the operator cares about.
    succeeded: healthy ? 1 : 0,
    failed: healthy ? 0 : 1,
    details,
    errors: [gmail.error, calendar.error].filter((e): e is string => !!e),
  };
}
