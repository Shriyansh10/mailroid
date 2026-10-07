/**
 * Backfill the `To` header onto already-synced Sent and Draft mail.
 *
 * A THIN WRAPPER, ON PURPOSE. The work lives in
 * @repo/services/admin-jobs/recipient-backfill, because the web app can import
 * @repo/services and cannot import @repo/scripts. Keeping the logic there means
 * the developer interface and this command run the same code; keeping a copy
 * here would mean they eventually wouldn't.
 *
 * Why the job is needed: `message_metadata.recipient` is filled by every sync
 * path now, but the bulk metadata walk never read the header before that column
 * existed. The Sent and Draft views show the recipient — every row there is
 * from the user, so the From header says nothing — and a NULL renders as
 * "(unknown)" rather than guessing.
 *
 * Resumable by construction: the cursor is "still pending", so re-running picks
 * up where it stopped and a partial run is never wasted.
 *
 * COST: `messages.get` is 20 quota units — Gmail prices the method, not the
 * payload, so asking for one header saves bandwidth and not quota. Scoped to
 * Sent/Draft, and skipping anything the read path can already answer from a
 * hydrated `emails` row, this is normally hundreds of rows rather than
 * thousands. Check the count the command prints before letting it run unbounded.
 *
 * RUN IT WITH A REDUCED RATE. This is a separate process from mailroid-api and
 * the pacing limiter's state is per-process, so this command and the running
 * server each believe they have the full budget. Set
 * GMAIL_QUOTA_UNITS_PER_SEC=25 when running it against a live mailbox.
 */

import {
  estimateRecipientBackfill,
  runRecipientBackfill,
} from "@repo/services/admin-jobs/recipient-backfill.js";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "gmail:backfill-recipients",
  description: "Fetch and store the To header for already-synced Sent/Draft mail",
  usage: "<userId|email> [--limit <n>] [--dry-run]",
  destructive: true, // writes to message_metadata

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "gmail");
    if (!userId) throw new UsageError(`No Gmail tenant found for "${arg}".`);

    const dryRun = args.includes("--dry-run");
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
    if (Number.isNaN(limit)) throw new UsageError("--limit needs a number.");

    const { rows: pending, units } = await estimateRecipientBackfill(userId);

    out.section("Backfill Sent/Draft recipients");
    out.keyValues([
      ["tenant id", userId],
      ["rows missing a recipient", pending],
      ["approx quota units", units],
      ["limit", limit === Infinity ? "none" : limit],
      ["mode", dryRun ? "DRY RUN — nothing written" : "writing"],
    ]);

    if (pending === 0) {
      out.line();
      out.success("Nothing to do.");
      return;
    }

    out.line();

    const result = await runRecipientBackfill(userId, {
      dryRun,
      limit,
      onProgress: (p) =>
        out.line(out.dim(`  …${p.processed} processed, ${p.stored} stored`)),
    });

    out.section("Result");
    out.counts([
      ["stored", result.stored],
      ["no To header", result.noHeader],
      ["gone from Gmail", result.gone],
      ["failed (retry later)", result.failed],
    ]);

    for (const err of result.errors) out.warn(err);

    if (result.failed > 0) {
      out.line();
      out.warn("Re-run to retry the failures — the pending cursor makes that safe.");
    }
  },
});
