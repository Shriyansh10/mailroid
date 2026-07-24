/**
 * Read-only view of a user's Gmail sync state.
 *
 * Exists to be run BEFORE gmail:resync, not after: a resync walks the whole
 * mailbox and is slow, so "is anything actually wrong, and is a sync already
 * running?" should be answerable without starting one. It's also the check
 * that confirms a finished resync did what it was supposed to — an empty Spam
 * or Draft count here is exactly the symptom the category sync fixes.
 */

import { getSyncStatus } from "@repo/services/gmail/sync-status.js";
import { getCategoryCounts } from "@repo/services/gmail/metadata.js";
import { ALL_CATEGORIES } from "@repo/services/gmail/metadata.js";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

/** Sidebar order, not enum order — this mirrors what the user sees in the app. */
const VIEW_ORDER = [
  "PRIMARY",
  "PROMOTIONS",
  "SOCIAL",
  "FORUMS",
  "SENT",
  "STARRED",
  "DRAFT",
  "SPAM",
  "TRASH",
];

export default defineCommand({
  name: "gmail:status",
  description: "Show sync state and per-view message counts",
  usage: "<userId|email>",

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "gmail");
    if (!userId) throw new UsageError(`No user found for "${arg}".`);

    out.section("User");
    out.keyValues([
      ["input", arg],
      ["tenant id", userId],
    ]);

    // ── Sync state ───────────────────────────────────────────────────
    const status = await getSyncStatus(userId);

    out.section("Sync");
    if (!status) {
      out.line(`  ${out.dim("No sync has ever run for this user.")}`);
    } else {
      const cursor = status.cursor as { categoryIndex?: number; pageToken?: string | null } | null;
      // The cursor stores a bare index into ALL_CATEGORIES; printing the number
      // alone tells you nothing about where the sync actually is.
      const currentCategory =
        cursor?.categoryIndex != null
          ? (ALL_CATEGORIES[cursor.categoryIndex] ?? `#${cursor.categoryIndex}`)
          : null;

      out.keyValues([
        ["status", status.status],
        ["processed", status.processed],
        ["estimated total", status.estimatedTotal],
        ["current category", currentCategory],
        ["started", status.startedAt],
        ["updated", status.updatedAt],
      ]);

      if (status.status === "running" || status.status === "queued") {
        out.warn("A sync is already in progress — let it finish before starting another.");
      }
    }

    // ── Per-view counts ──────────────────────────────────────────────
    const categoryCounts = await getCategoryCounts(userId);

    out.section("Views (distinct threads)");
    out.counts(VIEW_ORDER.map((view) => [view, categoryCounts[view] ?? 0]));

    // Any count key the service returns that isn't in VIEW_ORDER — so a new
    // category added later still shows up here instead of silently vanishing.
    const extra = Object.keys(categoryCounts).filter((k) => !VIEW_ORDER.includes(k));
    if (extra.length > 0) {
      out.counts(extra.map((view) => [view, categoryCounts[view] ?? 0]));
    }

    if ((categoryCounts.SPAM ?? 0) === 0 && (categoryCounts.DRAFT ?? 0) === 0) {
      out.line();
      out.warn(
        "Spam and Draft are both empty. If Gmail shows messages there, the category " +
          "sync hasn't run — try: gmail:resync",
      );
    }
  },
});
