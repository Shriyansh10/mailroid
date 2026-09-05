/**
 * Backfill the RFC822 `Message-ID` header onto already-synced mail.
 *
 * Why a Gmail re-fetch rather than SQL: the header was never stored, and
 * `emails.raw_payload` — the only place it could have been recovered from —
 * was dropped in migration 0030. So every row has to be asked for again.
 *
 * This exists because the guest-side meeting card joins an organiser's thread
 * to a guest's through this header. Until a message has one stored, a meeting
 * scheduled from its thread is invisible to the people invited to it, and the
 * thread page correctly reports "we can't tell" rather than "no meeting".
 *
 * Resumable by construction: the cursor is `rfc822_message_id IS NULL`, so
 * re-running picks up exactly where it stopped, and a partial run is never
 * wasted. Safe to run repeatedly.
 *
 * Read-only against Gmail (`messages.get`, requesting a single header rather
 * than the whole message).
 *
 * COST: `messages.get` is **20** quota units, not the 5 this comment used to
 * claim. Asking for one header rather than the full body saves bandwidth, not
 * quota — Gmail prices the method, not the payload. A 10,000-row backfill is
 * therefore ~200,000 units against a 6,000-units-per-minute mailbox budget:
 * over half an hour of that mailbox's entire allowance, at best.
 *
 * RUN IT WITH A REDUCED RATE. This is a separate process from mailroid-api, and
 * the pacing limiter's state is per-process — so this command and the running
 * server each believe they have the full budget. Set
 * GMAIL_QUOTA_UNITS_PER_SEC=25 when running it against a live mailbox.
 */

import { corsair } from "@repo/corsair";
import { db, and, eq, isNull, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { emails } from "@repo/database/models/emails";
import { normalizeMessageId } from "@repo/services/gmail/message-id";
import { withGmailRetry } from "@repo/services/gmail/retry.js";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

const PAGE_SIZE = 200;
const CONCURRENCY = 8;

/** Gmail treats a permanently-gone message as 404/410. */
function isGone(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 404 || status === 410;
}

export default defineCommand({
  name: "gmail:backfill-message-ids",
  description: "Fetch and store the RFC822 Message-ID for already-synced mail",
  usage: "<userId|email> [--limit <n>] [--dry-run]",
  destructive: true, // writes to message_metadata / emails

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "gmail");
    if (!userId) throw new UsageError(`No Gmail tenant found for "${arg}".`);

    const dryRun = args.includes("--dry-run");
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
    if (Number.isNaN(limit)) throw new UsageError("--limit needs a number.");

    const [{ count: pending } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messageMetadata)
      .where(
        and(
          eq(messageMetadata.userId, userId),
          isNull(messageMetadata.rfc822MessageId),
        ),
      );

    out.section("Backfill Message-IDs");
    out.keyValues([
      ["tenant id", userId],
      ["rows missing an id", pending],
      ["limit", limit === Infinity ? "none" : limit],
      ["mode", dryRun ? "DRY RUN — nothing written" : "writing"],
    ]);

    if (pending === 0) {
      out.line();
      out.success("Nothing to do.");
      return;
    }

    const tenant = corsair.withTenant(userId);
    let processed = 0;
    let stored = 0;
    let noHeader = 0;
    let gone = 0;
    let failed = 0;

    out.line();

    while (processed < limit) {
      // Re-querying rather than paging by offset is deliberate: rows leave the
      // result set as they're filled in, so an offset would skip work.
      const batch = await db
        .select({ entityId: messageMetadata.entityId })
        .from(messageMetadata)
        .where(
          and(
            eq(messageMetadata.userId, userId),
            isNull(messageMetadata.rfc822MessageId),
          ),
        )
        .limit(Math.min(PAGE_SIZE, limit - processed));

      if (batch.length === 0) break;

      let cursor = 0;
      const worker = async () => {
        while (cursor < batch.length) {
          const { entityId } = batch[cursor++]!;
          try {
            const msg = (await withGmailRetry(
              `messages.get ${entityId}`,
              () =>
                tenant.gmail.api.messages.get({
                  id: entityId,
                  format: "metadata",
                  // Only the one header — far less payload than format:"full"
                  // for the same quota cost.
                  metadataHeaders: ["Message-ID"],
                } as Parameters<typeof tenant.gmail.api.messages.get>[0]),
              { tenantId: userId, trigger: "sync" },
            )) as unknown as {
              payload?: { headers?: Array<{ name?: string; value?: string }> };
            };

            const header = msg.payload?.headers?.find(
              (h) => h.name?.toLowerCase() === "message-id",
            )?.value;
            const messageId = normalizeMessageId(header);

            if (!messageId) {
              noHeader++;
              // Stamp a sentinel so the NULL cursor drains — otherwise every
              // future run re-fetches the same header-less messages forever.
              if (!dryRun) {
                await db
                  .update(messageMetadata)
                  .set({ rfc822MessageId: "" })
                  .where(eq(messageMetadata.entityId, entityId));
              }
              continue;
            }

            if (!dryRun) {
              await db
                .update(messageMetadata)
                .set({ rfc822MessageId: messageId })
                .where(eq(messageMetadata.entityId, entityId));
              await db
                .update(emails)
                .set({ rfc822MessageId: messageId })
                .where(eq(emails.gmailMessageId, entityId));
            }
            stored++;
          } catch (error) {
            if (isGone(error)) {
              gone++;
              // Same reason as the header-less case: without this the cursor
              // never drains and the command loops on dead messages.
              if (!dryRun) {
                await db
                  .update(messageMetadata)
                  .set({ rfc822MessageId: "" })
                  .where(eq(messageMetadata.entityId, entityId));
              }
              continue;
            }
            failed++;
            out.warn(`${entityId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      };

      await Promise.all(Array.from({ length: CONCURRENCY }, worker));

      processed += batch.length;
      out.line(out.dim(`  …${processed} processed, ${stored} stored`));

      // A dry run never fills anything in, so the same page would come back
      // forever. One page is enough to see what it would do.
      if (dryRun) break;
    }

    out.section("Result");
    out.counts([
      ["stored", stored],
      ["no Message-ID header", noHeader],
      ["gone from Gmail", gone],
      ["failed (retry later)", failed],
    ]);

    if (failed > 0) {
      out.line();
      out.warn("Re-run to retry the failures — the NULL cursor makes that safe.");
    }
    if (!dryRun && stored > 0) {
      out.line();
      out.line(out.dim("Next: pnpm admin calendar:backfill-shared-props <user> --dry-run"));
    }
  },
});
