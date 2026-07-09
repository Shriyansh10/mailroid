import { inngest } from "@repo/inngest";
import { syncCategoryPage } from "./sync-metadata.js";
import { ALL_CATEGORIES } from "./metadata.js";

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
 * NOTE: this lives in @repo/services (not @repo/inngest) because it needs
 * syncCategoryPage/ALL_CATEGORIES from this package, and @repo/services
 * already depends on @repo/inngest — defining it here keeps that dependency
 * one-directional (turbo rejects a @repo/inngest <-> @repo/services cycle).
 * Same pattern as gmailWatchCron in ./watch-cron.ts.
 */
export const gmailInitialSync = inngest.createFunction(
  {
    id: "gmail-initial-sync",
    // Cap simultaneous syncs so a burst of new connections can't exhaust the
    // API container. Per-user Gmail rate limiting is handled inside
    // syncCategoryPage (concurrency cap + backoff/retry).
    concurrency: { limit: 5 },
    retries: 4,
  },
  { event: "gmail/sync.requested" },
  async ({ event, step }) => {
    const userId: string = event.data.userId;
    let categoryIndex: number = event.data.categoryIndex ?? 0;
    let pageToken: string | undefined = event.data.pageToken ?? undefined;
    let syncedTotal: number = event.data.syncedTotal ?? 0;
    let pagesThisRun = 0;

    while (categoryIndex < ALL_CATEGORIES.length) {
      const category = ALL_CATEGORIES[categoryIndex]!;

      // pagesThisRun increments across the whole run (not reset per category),
      // so this step id is unique within the run and deterministic on replay.
      const { processed, nextPageToken } = await step.run(
        `sync-${category}-page-${pagesThisRun}`,
        () => syncCategoryPage(userId, category, pageToken),
      );

      syncedTotal += processed;
      pagesThisRun += 1;

      if (nextPageToken) {
        pageToken = nextPageToken;
      } else {
        categoryIndex += 1;
        pageToken = undefined;
      }

      if (
        pagesThisRun >= MAX_PAGES_PER_RUN &&
        categoryIndex < ALL_CATEGORIES.length
      ) {
        await step.sendEvent("continue-gmail-sync", {
          name: "gmail/sync.requested",
          data: { userId, categoryIndex, pageToken, syncedTotal },
        });
        return { userId, syncedTotal, continued: true };
      }
    }

    return { userId, syncedTotal, done: true };
  },
);
