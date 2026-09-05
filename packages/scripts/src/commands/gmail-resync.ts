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

import { db, eq } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { triggerGmailSync } from "@repo/services/gmail/sync-metadata.js";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import { confirmDestructive, hasYesFlag, stripYesFlag } from "../lib/confirm.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "gmail:resync",
  description: "Re-sync the FULL mailbox (slow — prefer gmail:resync-categories)",
  usage: "<userId|email> [--yes]",
  destructive: true,

  async run(rawArgs) {
    const skipPrompt = hasYesFlag(rawArgs);
    const args = stripYesFlag(rawArgs);

    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "gmail");
    if (!userId) throw new UsageError(`No user found for "${arg}".`);

    // P-3, docs/gmail-rate-limit-boundary.md §13: a history-retention 404 no
    // longer fires this automatically — it sets resyncRequired and waits for
    // exactly this command. Read it so the operator sees WHY, if that's what
    // brought them here, rather than resyncing blind.
    const [mapping] = await db
      .select({
        resyncRequired: gmailTenantMappings.resyncRequired,
        resyncRequiredAt: gmailTenantMappings.resyncRequiredAt,
      })
      .from(gmailTenantMappings)
      .where(eq(gmailTenantMappings.tenantId, userId))
      .limit(1);

    if (mapping?.resyncRequired) {
      out.warn(
        `resyncRequired is set (since ${mapping.resyncRequiredAt?.toISOString()}) — ` +
          `a webhook diff hit a history-retention 404 for this mailbox.`,
      );
    }

    // There is no incremental mode: this re-lists every category and issues a
    // threads.get per thread, so cost scales with the whole mailbox, not with
    // what's actually missing. Worth saying before a two-hour run starts.
    out.warn(
      "This re-walks the entire mailbox. To refresh specific folders only, use: " +
        "gmail:resync-categories",
    );

    const confirmed = await confirmDestructive(
      `About to re-sync the FULL mailbox for tenant ${userId} (${arg}). This is a slow, ` +
        `whole-mailbox walk — cost scales with everything in it, not just what changed.`,
      skipPrompt,
    );
    if (!confirmed) {
      out.warn("Aborted.");
      return;
    }

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

    // force: true — P-4's diff must not silently turn an operator's explicit
    // "resync this mailbox" into a no-op because Gmail reports every thread
    // unchanged. That diff is for routine automatic syncs; a deliberate CLI
    // resync means re-derive everything, unconditionally.
    await triggerGmailSync(userId, { force: true });

    // Cleared only on the path that has actually finished by the time we get
    // here. The durable (Inngest) path returns as soon as the job is
    // enqueued — clearing the flag now would mark this resolved before the
    // walk has even started, which is worse than leaving it set: an operator
    // reading watch-health would see "healthy" for a sync that hasn't run
    // yet, exactly the kind of state-outrunning-reality this document is
    // about. The in-process path blocks until triggerGmailSync above
    // actually returns, so clearing here is honest.
    if (!durable && mapping?.resyncRequired) {
      await db
        .update(gmailTenantMappings)
        .set({ resyncRequired: false, resyncRequiredAt: null })
        .where(eq(gmailTenantMappings.tenantId, userId));
    }

    out.line();
    if (durable) {
      out.success("Enqueued. Track it in the Inngest dashboard (function: gmail-initial-sync).");
      out.line(`  ${out.dim("Then check progress with: gmail:status " + arg)}`);
      if (mapping?.resyncRequired) {
        out.line(
          `  ${out.dim("resyncRequired stays set until this finishes — clear it manually if needed:")}`,
        );
        out.line(`  ${out.dim(`UPDATE gmail_tenant_mappings SET resync_required = false WHERE tenant_id = '${userId}';`)}`);
      }
    } else {
      out.success("In-process sync complete.");
      out.line(`  ${out.dim("Verify with: gmail:status " + arg)}`);
    }
  },
});
