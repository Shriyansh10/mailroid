/**
 * Re-sync a user's entire Gmail mailbox.
 *
 * Migrated from apps/api/src/scripts/resync-gmail.ts.
 *
 * This is the only way to populate Spam, Bin and Drafts: those categories are
 * excluded from ordinary Gmail listings and are walked only by the full
 * category sync, which otherwise runs just once, at OAuth connect. The in-app
 * "Sync" button is a different (and much narrower) path.
 *
 * Idempotent — the metadata upsert is keyed on message id, so re-running fills
 * gaps rather than duplicating. It is also how a category-derivation fix gets
 * applied to already-synced mail, since every row is re-upserted.
 */

import { triggerGmailSync } from "@repo/services/gmail/sync-metadata.js";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "gmail:resync",
  description: "Re-sync the FULL mailbox (slow — prefer gmail:resync-categories)",
  usage: "<userId|email>",
  destructive: true,

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "gmail");
    if (!userId) throw new UsageError(`No user found for "${arg}".`);

    // There is no incremental mode: this re-lists every category and issues a
    // threads.get per thread, so cost scales with the whole mailbox, not with
    // what's actually missing. Worth saying before a two-hour run starts.
    out.warn(
      "This re-walks the entire mailbox. To refresh specific folders only, use: " +
        "gmail:resync-categories",
    );

    // Without INNGEST_EVENT_KEY this runs in-process and blocks until the whole
    // mailbox is walked, which for a large account is a long wait with no
    // resumability. Worth saying up front rather than leaving the caller
    // wondering whether it hung.
    const durable = Boolean(process.env.INNGEST_EVENT_KEY);

    out.section("Re-sync");
    out.keyValues([
      ["tenant id", userId],
      ["mode", durable ? "durable (Inngest)" : "in-process (blocking, not resumable)"],
    ]);

    if (!durable) {
      out.warn("INNGEST_EVENT_KEY is not set — this will block until the sync completes.");
      // `pnpm admin` pins LOGGER_LEVEL=error, which silences the per-page sync
      // logging. On the blocking path that logging is the only sign of life,
      // so point at the variant that keeps it.
      out.line(
        `  ${out.dim("For progress output, re-run with: pnpm admin:verbose")}`,
      );
    }

    await triggerGmailSync(userId);

    out.line();
    if (durable) {
      out.success("Enqueued. Track it in the Inngest dashboard (function: gmail-initial-sync).");
      out.line(`  ${out.dim("Then check progress with: gmail:status " + arg)}`);
    } else {
      out.success("In-process sync complete.");
      out.line(`  ${out.dim("Verify with: gmail:status " + arg)}`);
    }
  },
});
