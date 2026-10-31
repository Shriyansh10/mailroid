/**
 * The daily attachment-cache eviction sweep.
 *
 * ITS OWN FUNCTION, NOT A STEP IN reconciliationCron, for three reasons that all
 * point the same way. It must be a total no-op when the cache is off, which is a
 * property that is easy to state here and easy to lose inside a shared sweep. An
 * object-storage outage must not fail the run that re-kicks stalled Gmail syncs —
 * those are unrelated concerns and coupling them means a Spaces incident stops
 * mail from recovering. And keeping it separate is what let Stage 2 be purely
 * additive.
 *
 * Lives in @repo/services rather than @repo/inngest for the same
 * one-directional-dependency reason as gmailInitialSync — see initial-sync.ts.
 *
 * Paired with a manual event trigger, matching every other cron in this repo:
 * `attachments/evict.requested` makes the sweep runnable on demand, which is how
 * it gets tested against a backdated row without waiting for 03:30.
 */
import { inngest } from "@repo/inngest";
import { logger } from "@repo/logger";

import { evictExpiredAttachments } from "./eviction.ts";

export const attachmentCacheEvictionCron = inngest.createFunction(
  { id: "attachment-cache-eviction-cron" },
  [{ cron: "30 3 * * *" }, { event: "attachments/evict.requested" }],
  async ({ step }) => {
    // ONE step.run for the whole batch, not one per object.
    //
    // A step per object would mean up to 500 durable checkpoints per run, which
    // blows the step budget and buys nothing: the sweep is already idempotent by
    // construction (a cleared row cannot re-match the query), so replaying the
    // whole batch after a failure is both safe and cheaper than remembering
    // where it stopped.
    const result = await step.run("evict-expired-cached-attachments", () =>
      evictExpiredAttachments(),
    );

    if (result.failed > 0) {
      logger.warn("[ATTACHMENTS] eviction finished with failures; rows retried next run", {
        failed: result.failed,
        scanned: result.scanned,
      });
    }

    return result;
  },
);
