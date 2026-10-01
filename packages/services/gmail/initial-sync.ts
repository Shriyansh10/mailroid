import { inngest } from "@repo/inngest";
import { syncCategoryPage } from "./sync-metadata.ts";
import { ALL_CATEGORIES } from "./metadata.ts";
import { hasPendingSyncFailures } from "./sync-failures.ts";
import {
  markSyncRunning,
  updateSyncProgress,
  markSyncComplete,
  markSyncFailed,
  estimateMailboxTotal,
} from "./sync-status.ts";

// Hand off to a fresh function run after this many pages so the memoized
// step state of a single run stays bounded on very large mailboxes (25k+
// messages = hundreds of pages). Each page is ~100 threads.
const MAX_PAGES_PER_RUN = 15;

/**
 * Durable, resumable full-mailbox sync.
 *
 * Triggered by the `gmail/sync.requested` event `{ userId }`. Each Gmail page
 * is its own `step.run`, so Inngest checkpoints after every page — a redeploy
 * or crash mid-sync resumes from the exact page it left off (the loop replays
 * but completed steps return memoized results instead of re-fetching). When a
 * run reaches MAX_PAGES_PER_RUN it emits a continuation event carrying the
 * current category index + page token, keeping any single run bounded.
 *
 * Re-syncing any account = send `gmail/sync.requested` with that userId.
 *
 * `gmail_sync_status` (see sync-status.ts) is this function's only durable
 * trace outside of Inngest's own run history — it's what lets the UI poll
 * for progress and know when it's safe to unlock historical classification.
 * `categoryIndex === undefined` on the incoming event is what distinguishes a
 * genuinely first run from a continuation (a continuation always sets it
 * explicitly, even to 0), so only the first run writes `running` and only the
 * run whose loop exits with nextPageToken == null on every category writes
 * `complete`. Continuation runs must never touch `status`.
 *
 * NOTE: this lives in @repo/services (not @repo/inngest) because it needs
 * syncCategoryPage/ALL_CATEGORIES from this package, and @repo/services
 * already depends on @repo/inngest — defining it here keeps that dependency
 * one-directional (turbo rejects a @repo/inngest <-> @repo/services cycle).
 * Same pattern as gmailWatchCron in ./watch-cron.ts.
 */
export const gmailInitialSync = inngest.createFunction(
  {
    id: "gmail-initial-sync",
    // PINNED to 1, not configurable (P-5b + P-12, docs/gmail-rate-limit-boundary.md
    // §13). This used to be `Number(process.env.INITIAL_SYNC_CONCURRENCY ?? 1)`
    // — a knob that bounded concurrent syncs PER INNGEST APP, i.e. per
    // environment. That is B-3 in different clothes: two environments each
    // running their own "concurrency 1" limit still allows two simultaneous
    // initial syncs against the SAME mailbox, because the cap was never keyed
    // on the mailbox. The real per-mailbox ceiling now lives in
    // mailbox-semaphore.ts, acquired transparently at the transport boundary
    // by every Gmail call this function's syncCategoryPage steps make — see
    // docs/gmail-call-graph.md. This Inngest-level knob is kept only to bound
    // how many DIFFERENT mailboxes' initial syncs run at once on one
    // container; raising it no longer relaxes any per-mailbox limit, so it is
    // pinned rather than left as an env var that would misleadingly suggest
    // otherwise.
    concurrency: { limit: 1 },
    retries: 4,
    onFailure: async ({ event }) => {
      // onFailure's event wraps the original triggering event at event.data.event
      // — the original `gmail/sync.requested` payload, not this failure event.
      const userId: string | undefined = event.data.event?.data?.userId;
      if (userId) await markSyncFailed(userId);
    },
  },
  { event: "gmail/sync.requested" },
  async ({ event, step }) => {
    const userId: string = event.data.userId;
    // P-4 (docs/gmail-rate-limit-boundary.md §13). Carried through every
    // continuation event below so a resync that started forced stays forced
    // across MAX_PAGES_PER_RUN boundaries — losing it partway through would
    // silently start diffing (and skipping) threads the operator asked to
    // have re-fetched unconditionally.
    const force: boolean = event.data.force ?? false;
    const isFirstRun = event.data.categoryIndex === undefined;
    let categoryIndex: number = event.data.categoryIndex ?? 0;
    let pageToken: string | undefined = event.data.pageToken ?? undefined;
    let pagesThisRun = 0;
    // Deduped row count from the last progress write. Not carried across
    // continuation events — updateSyncProgress recounts from the DB, so a
    // continuation picks up the correct total without being told it.
    let syncedTotal = 0;

    if (isFirstRun) {
      const estimatedTotal = await step.run("sync-status-estimate", () =>
        estimateMailboxTotal(userId),
      );
      await step.run("sync-status-running", () => markSyncRunning(userId, estimatedTotal));
    }

    while (categoryIndex < ALL_CATEGORIES.length) {
      const category = ALL_CATEGORIES[categoryIndex]!;

      // pagesThisRun increments across the whole run (not reset per category),
      // so this step id is unique within the run and deterministic on replay.
      const { nextPageToken } = await step.run(
        `sync-${category}-page-${pagesThisRun}`,
        () => syncCategoryPage(userId, category, pageToken, force),
      );

      pagesThisRun += 1;

      if (nextPageToken) {
        pageToken = nextPageToken;
      } else {
        categoryIndex += 1;
        pageToken = undefined;
      }

      // The page's own `processed` is deliberately discarded — it counts
      // thread expansions, which double-count across categories (see
      // countSyncedMessages). The DB row count is the progress number.
      syncedTotal = await step.run(`sync-status-progress-${pagesThisRun}`, () =>
        updateSyncProgress(userId, { categoryIndex, pageToken: pageToken ?? null }),
      );

      if (
        pagesThisRun >= MAX_PAGES_PER_RUN &&
        categoryIndex < ALL_CATEGORIES.length
      ) {
        await step.sendEvent("continue-gmail-sync", {
          name: "gmail/sync.requested",
          data: { userId, categoryIndex, pageToken, force },
        });
        return { userId, syncedTotal, continued: true };
      }
    }

    const total = await step.run("sync-status-complete", () => markSyncComplete(userId));

    // Threads this sync could not fetch were recorded as they failed. Start
    // their retry now rather than waiting for the 15-minute sweep; the worker
    // still honours each row's next_attempt_at, so a cooldown is not cut short.
    const owesRetries = await step.run("check-sync-failures", () => hasPendingSyncFailures(userId));
    if (owesRetries) {
      await step.sendEvent("retry-sync-failures", {
        name: "gmail/sync-failures.retry",
        data: { userId },
      });
    }

    return { userId, syncedTotal: total, done: true, owesRetries };
  },
);
