/**
 * Re-sync only the named categories.
 *
 * The full `gmail:resync` has no incremental mode — it re-walks every category
 * and issues a threads.get per thread, which on a large mailbox is ~2 hours of
 * quota-bound API calls. When only one folder is actually stale (Spam and
 * Drafts being the common case, since nothing else fetches them), re-fetching
 * the whole mailbox to collect a few dozen messages is pure waste. This walks
 * just the categories you name.
 *
 * Two deliberate differences from the full resync:
 *
 *  - **Runs in-process and blocks.** The durable Inngest job walks
 *    ALL_CATEGORIES by index and can't express a subset, so a targeted run
 *    can't use it. That's fine at this size — a few dozen messages is seconds —
 *    but it does mean the run isn't resumable, so keep the list small.
 *
 *  - **Doesn't touch gmail_sync_status.** That row describes a whole-mailbox
 *    sync; writing partial progress into it would overwrite a legitimate
 *    "complete" with numbers that only ever covered a slice.
 */

import { syncAllEmails } from "@repo/services/gmail/sync-metadata.js";
import { ALL_CATEGORIES } from "@repo/services/gmail/metadata.js";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

function parseCategories(raw: string | undefined): string[] {
  if (!raw) throw new UsageError("Missing <CATEGORY[,CATEGORY...]>.");

  const requested = raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

  if (requested.length === 0) throw new UsageError("No categories given.");

  const unknown = requested.filter((c) => !ALL_CATEGORIES.includes(c));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown categor${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")}. ` +
        `Valid: ${ALL_CATEGORIES.join(", ")}`,
    );
  }

  // De-duplicate: syncing the same category twice in one run is just doubled
  // API cost for an identical result.
  return [...new Set(requested)];
}

export default defineCommand({
  name: "gmail:resync-categories",
  description: "Re-sync only the named categories (fast — use for Spam/Drafts)",
  usage: "<userId|email> <CATEGORY[,CATEGORY...]>",
  destructive: true,

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const categories = parseCategories(args[1]);

    const userId = await resolveUserId(arg, "gmail");
    if (!userId) throw new UsageError(`No user found for "${arg}".`);

    out.section("Targeted re-sync");
    out.keyValues([
      ["tenant id", userId],
      ["categories", categories.join(", ")],
      ["mode", "in-process (blocking, not resumable)"],
    ]);
    out.line();

    const results: Array<[string, number]> = [];
    for (const category of categories) {
      // Each category is isolated so one failure (an exhausted retry on a big
      // folder) doesn't abandon the categories after it — same reasoning as
      // syncMailbox's per-category try/catch.
      try {
        // force: true — same reasoning as gmail:resync (P-4,
        // docs/gmail-rate-limit-boundary.md §13): an operator naming a
        // category to refresh means refresh it, not "skip whatever Gmail's
        // diff says is unchanged."
        const processed = await syncAllEmails(userId, category, 0, undefined, true);
        results.push([category, processed]);
        out.success(`${category}: ${processed} message(s)`);
      } catch (err) {
        results.push([category, 0]);
        out.error(`${category}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    out.section("Processed");
    out.counts(results);

    out.line();
    out.line(`  ${out.dim(`Verify with: pnpm admin gmail:status ${arg}`)}`);
  },
});
