/**
 * The catalogue of maintenance jobs the developer interface knows about.
 *
 * THIS LIST IS THE SECURITY BOUNDARY. The UI can only name an id from here;
 * nothing the browser sends ever becomes a command, a path or a query. That is
 * deliberate and is the reason there is no "run an arbitrary admin command"
 * box: such a box is a remote code execution surface wearing a different hat,
 * and no amount of role-checking in front of it makes it one worth having.
 *
 * Every job is listed, including the ones that cannot yet be run from the web.
 * A catalogue that silently omits the jobs it hasn't wired up teaches the
 * operator that the list is the whole truth, and then quietly isn't — so
 * unwired jobs appear with `runner: null` and the exact command to run instead.
 */

import { clearGmailAuthLatch } from "../gmail/auth-latch.ts";
import {
  estimateRecipientBackfill,
  runRecipientBackfill,
} from "./recipient-backfill.ts";
import { estimateWatchRenewal, runWatchRenewal } from "./watch-renewal.ts";
import { estimateCredentialCheck, runCredentialCheck } from "./credential-check.ts";

export type JobRisk =
  /** Reads only. Cannot change anything. */
  | "read-only"
  /** Writes, but only to our own tables. No outward-facing effect. */
  | "writes-local"
  /** Spends the mailbox's Gmail quota. */
  | "spends-quota"
  /** Visible to the user or to the people they correspond with. */
  | "outward-facing";

export interface JobEstimate {
  rows: number;
  units: number;
  /** Shown verbatim under the numbers. Say what the numbers mean. */
  note?: string;
}

export interface JobRunResult {
  processed: number;
  succeeded: number;
  failed: number;
  details?: Record<string, unknown>;
  errors?: string[];
}

export interface JobRunner {
  /**
   * Read-only forecast, run before the operator is allowed to arm anything.
   * It must never write, because it is run automatically on selection.
   */
  estimate(userId: string): Promise<JobEstimate>;
  run(
    userId: string,
    opts: { dryRun: boolean; onProgress?: (p: JobRunResult) => Promise<void> | void },
  ): Promise<JobRunResult>;
}

export interface JobDefinition {
  id: string;
  title: string;
  /** What it does, in a sentence an operator can act on. */
  description: string;
  risk: JobRisk;
  /** Whether "all users" is a sensible target for this job. */
  supportsAllUsers: boolean;
  /**
   * Quota-spending jobs are skipped for a mailbox already known to be
   * auth-dead, because attempting them wastes calls to rediscover that. A job
   * whose PURPOSE is to determine or repair auth health must opt out, or the
   * guard prevents exactly the diagnosis it exists to enable.
   */
  runsDespiteAuthFailure?: boolean;
  /**
   * null means "catalogued but not wired to the web yet" — the UI shows it
   * greyed with `cliCommand` instead of a run button.
   */
  runner: JobRunner | null;
  /** The equivalent terminal command, always shown so the UI is never the only way. */
  cliCommand: string;
}

/** Jobs runnable from the web today. */
const WIRED: JobDefinition[] = [
  {
    id: "gmail:backfill-recipients",
    title: "Backfill Sent/Draft recipients",
    description:
      "Fetches the To header for Sent and Draft mail synced before the recipient column existed. Those rows render as “To (unknown)” until this runs. New mail does not need it.",
    risk: "spends-quota",
    supportsAllUsers: true,
    cliCommand: "pnpm admin gmail:backfill-recipients <email>",
    runner: {
      estimate: async (userId) => {
        const { rows, units } = await estimateRecipientBackfill(userId);
        return {
          rows,
          units,
          note: `${rows} message${rows === 1 ? "" : "s"} to re-fetch at 20 quota units each. Gmail's limit is per-mailbox, so this does not contend with other users.`,
        };
      },
      run: async (userId, { dryRun, onProgress }) => {
        const r = await runRecipientBackfill(userId, {
          dryRun,
          onProgress: onProgress
            ? (p) =>
                onProgress({
                  processed: p.processed,
                  succeeded: p.stored,
                  failed: p.failed,
                  details: { noHeader: p.noHeader, gone: p.gone },
                })
            : undefined,
        });
        return {
          processed: r.processed,
          succeeded: r.stored,
          failed: r.failed,
          details: { noHeader: r.noHeader, gone: r.gone },
          errors: r.errors,
        };
      },
    },
  },
  {
    id: "connections:check-credentials",
    title: "Refresh & verify Gmail + Calendar credentials",
    description:
      "Forces an access-token refresh on both services and reports, per mailbox, which are healthy and which need the user to reconnect. Also clears a stuck auth latch. It cannot revive a revoked grant — only the user re-consenting can do that.",
    risk: "spends-quota",
    supportsAllUsers: true,
    // The whole point is to run against mailboxes whose auth may be dead.
    runsDespiteAuthFailure: true,
    cliCommand: "(developer interface only)",
    runner: {
      estimate: () => estimateCredentialCheck(),
      run: async (userId, { dryRun }) => {
        const r = await runCredentialCheck(userId, { dryRun });
        return {
          processed: r.processed,
          succeeded: r.succeeded,
          failed: r.failed,
          details: r.details,
          errors: r.errors,
        };
      },
    },
  },
  {
    id: "gmail:renew-watch",
    title: "Renew Gmail watches",
    description:
      "Re-registers the Gmail push subscription for mailboxes whose watch has lapsed or expires within 48 hours. A lapsed watch means the mailbox silently stops receiving new mail. Healthy mailboxes are skipped, so running this across everyone is cheap and safe to repeat.",
    risk: "spends-quota",
    supportsAllUsers: true,
    cliCommand: "pnpm admin gmail:renew-watch <email>",
    runner: {
      estimate: estimateWatchRenewal,
      run: async (userId, { dryRun }) => {
        const r = await runWatchRenewal(userId, { dryRun });
        return {
          processed: r.processed,
          succeeded: r.succeeded,
          failed: r.failed,
          details: r.details,
          errors: r.errors,
        };
      },
    },
  },
  {
    id: "gmail:clear-auth-latch",
    title: "Clear stuck auth latch",
    description:
      "Clears gmail_auth_failed_at for a mailbox stuck in AUTH_FAILED after its credentials were already repaired. Makes no Gmail calls and costs no quota. Harmless on a healthy mailbox — it updates nothing.",
    risk: "writes-local",
    supportsAllUsers: true,
    cliCommand: "(SQL — see auth-latch.ts)",
    runner: {
      // Nothing to count: the operation is a single conditional UPDATE whose
      // own WHERE clause decides whether there is anything to do.
      estimate: async () => ({
        rows: 0,
        units: 0,
        note: "No Gmail calls, no quota. Clears the latch if set, does nothing if not.",
      }),
      run: async (userId, { dryRun }) => {
        if (dryRun) {
          return {
            processed: 0,
            succeeded: 0,
            failed: 0,
            details: { note: "Dry run: the latch was not touched." },
          };
        }
        await clearGmailAuthLatch(userId, { trigger: "ui", operation: "clear-auth-latch" });
        return { processed: 1, succeeded: 1, failed: 0 };
      },
    },
  },
];

/**
 * Catalogued, not yet wired. Their logic still lives in packages/scripts, which
 * the web image deliberately does not contain — moving each one into this
 * package is the work that promotes it into WIRED.
 */
const CLI_ONLY: Array<Omit<JobDefinition, "runner">> = [
  {
    id: "gmail:backfill-message-ids",
    title: "Backfill RFC822 Message-IDs",
    description:
      "Fetches the Message-ID header for already-synced mail. Needed for guest-side meeting matching. Same 20-units-per-message cost, across the whole mailbox rather than just Sent.",
    risk: "spends-quota",
    supportsAllUsers: true,
    cliCommand: "pnpm admin gmail:backfill-message-ids <email>",
  },
  {
    id: "gmail:resync",
    title: "Full Gmail resync",
    description:
      "Re-walks the mailbox and rebuilds message metadata. The most quota-hungry job here by a wide margin.",
    risk: "spends-quota",
    supportsAllUsers: false,
    cliCommand: "pnpm admin gmail:resync <email>",
  },
  {
    id: "gmail:resync-categories",
    title: "Resync categories",
    description: "Recomputes category assignment from Gmail labels.",
    risk: "spends-quota",
    supportsAllUsers: false,
    cliCommand: "pnpm admin gmail:resync-categories <email>",
  },
  {
    id: "gmail:backfill-priority",
    title: "Backfill priority",
    description: "Re-runs priority classification over historical mail. Costs LLM tokens, not Gmail quota.",
    risk: "writes-local",
    supportsAllUsers: true,
    cliCommand: "pnpm admin gmail:backfill-priority <email>",
  },
  {
    id: "gmail:status",
    title: "Gmail status",
    description: "Reports sync state, watch expiry and cooldown for a mailbox.",
    risk: "read-only",
    supportsAllUsers: false,
    cliCommand: "pnpm admin gmail:status <email>",
  },
  {
    id: "gmail:quota-reconcile",
    title: "Reconcile quota ledger",
    description: "Compares the local call ledger against observed usage.",
    risk: "read-only",
    supportsAllUsers: false,
    cliCommand: "pnpm admin gmail:quota-reconcile <email>",
  },
  {
    id: "gmail:release-watch",
    title: "Release Gmail watch",
    description: "Stops push notifications for a mailbox. Webhook mail stops arriving until renewed.",
    risk: "outward-facing",
    supportsAllUsers: false,
    cliCommand: "pnpm admin gmail:release-watch <email>",
  },
  {
    id: "gmail:disconnect",
    title: "Disconnect Gmail",
    description: "Removes the mailbox connection. The user must reconnect to restore service.",
    risk: "outward-facing",
    supportsAllUsers: false,
    cliCommand: "pnpm admin gmail:disconnect <email>",
  },
  {
    id: "calendar:backfill-shared-props",
    title: "Backfill calendar shared properties",
    description: "Stamps thread Message-ID properties onto existing events so guests can match them.",
    risk: "spends-quota",
    supportsAllUsers: true,
    cliCommand: "pnpm admin calendar:backfill-shared-props <email>",
  },
  {
    id: "calendar:probe-shared-props",
    title: "Probe calendar shared properties",
    description: "Checks whether events carry the shared properties guest lookup depends on.",
    risk: "read-only",
    supportsAllUsers: false,
    cliCommand: "pnpm admin calendar:probe-shared-props <email>",
  },
  {
    id: "calendar:test-guest-lookup",
    title: "Test guest meeting lookup",
    description: "Runs the guest-side thread-to-meeting join and reports what it found.",
    risk: "read-only",
    supportsAllUsers: false,
    cliCommand: "pnpm admin calendar:test-guest-lookup <email>",
  },
  {
    id: "calendar:list-events",
    title: "List calendar events",
    description: "Dumps events in a window for inspection.",
    risk: "read-only",
    supportsAllUsers: false,
    cliCommand: "pnpm admin calendar:list-events <email>",
  },
  {
    id: "calendar:inspect-event",
    title: "Inspect one calendar event",
    description: "Full dump of a single event, including extended properties.",
    risk: "read-only",
    supportsAllUsers: false,
    cliCommand: "pnpm admin calendar:inspect-event <email> <eventId>",
  },
  {
    id: "calendar:stop-channels",
    title: "Stop calendar channels",
    description: "Tears down calendar push channels. Calendar webhooks stop until re-registered.",
    risk: "outward-facing",
    supportsAllUsers: false,
    cliCommand: "pnpm admin calendar:stop-channels <email>",
  },
  {
    id: "ai:usage",
    title: "AI usage report",
    description: "Token spend and cost per model over a period.",
    risk: "read-only",
    supportsAllUsers: false,
    cliCommand: "pnpm admin ai:usage",
  },
];

export const JOBS: JobDefinition[] = [
  ...WIRED,
  ...CLI_ONLY.map((j) => ({ ...j, runner: null })),
];

/**
 * Resolve an id to a job. Returns undefined for anything not in the catalogue —
 * callers must treat that as a rejection, never as "run it anyway".
 */
export function findJob(id: string): JobDefinition | undefined {
  return JOBS.find((j) => j.id === id);
}

/** The catalogue minus the runners, which do not serialise. */
export function listJobsForClient() {
  return JOBS.map(({ runner, ...rest }) => ({ ...rest, runnable: runner !== null }));
}
