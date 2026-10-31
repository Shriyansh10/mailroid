/**
 * Late-object detector — the one scheduled job in account deletion, and it
 * never deletes anything.
 *
 * Hourly, it re-scans the storage prefix of every request that is COMPLETED or
 * AWAITING_SEAL (storage mode is LIFECYCLE_ONLY until the deny qualification
 * passes on a real bucket, so hourly is the D-010 cadence):
 *   - an object under a completed user's prefix → INTEGRITY_INCIDENT, which a
 *     developer remediates by hand (account:remediate);
 *   - an AWAITING_SEAL request whose scan now verifies → COMPLETED.
 * Neither is a deletion, and no request is ever moved toward one.
 *
 * Rolled up into one log line per run (successes are a statistic); every
 * failure is logged in full.
 *
 * HEARTBEAT / EXTERNAL MONITOR: pending Phase 0 step 11. Until a dead-man
 * monitor exists, a stopped detector is noticed only by `account:requests`.
 */
import { inngest } from "@repo/inngest";
import { logger } from "@repo/logger";

import { listDeletionRequests, verifyStorage, DeletionError } from "./service.ts";

export const accountDeletionDetectorCron = inngest.createFunction(
  { id: "account-deletion-late-object-detector", concurrency: { limit: 1 } },
  [{ cron: "17 * * * *" }, { event: "account-deletion/detect.requested" }],
  async ({ step }) => {
    return step.run("scan-deleted-prefixes", async () => {
      const rows = await listDeletionRequests({ status: ["COMPLETED", "AWAITING_SEAL"], limit: 1000 });
      let clean = 0;
      let incidents = 0;
      let completed = 0;
      let failed = 0;
      for (const r of rows) {
        try {
          const res = await verifyStorage({ id: r.id, actor: { type: "SYSTEM" } });
          if (res.request.status === "INTEGRITY_INCIDENT") {
            incidents++;
            logger.error("[account-deletion] late objects after completion", {
              requestId: r.id,
              objects: res.scan.objects,
              uploads: res.scan.uploads,
              sampleKeys: res.scan.sampleKeys,
            });
          } else if (r.status === "AWAITING_SEAL" && res.request.status === "COMPLETED") completed++;
          else if (res.request.status === "PURGE_FAILED") {
            // The completion transaction (minimisation and its checks) failed
            // and rolled back. Never counted as clean: a developer runs account:retry.
            failed++;
            logger.error("[account-deletion] completion failed after storage verified", { requestId: r.id, error: res.request.lastError });
          }
          else if (!res.scan.complete) {
            failed++;
            logger.error("[account-deletion] detector scan incomplete", { requestId: r.id, error: res.scan.error });
          } else clean++;
        } catch (err) {
          failed++;
          logger.error("[account-deletion] detector failed for request", {
            requestId: r.id,
            code: err instanceof DeletionError ? err.code : undefined,
            error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err),
          });
        }
      }
      logger.info("[account-deletion] detector run", { scanned: rows.length, clean, incidents, completed, failed });
      return { scanned: rows.length, clean, incidents, completed, failed };
    });
  },
);
