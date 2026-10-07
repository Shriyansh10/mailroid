/**
 * The Sent/Draft recipient backfill, as a service rather than a CLI command.
 *
 * It lives here and not in packages/scripts because the web app can import
 * @repo/services and cannot import @repo/scripts — `turbo prune web` resolves
 * the former into the image and not the latter. The CLI command is now a thin
 * wrapper around this, so there is exactly one implementation of the work and
 * the developer UI and the terminal cannot drift apart.
 *
 * See the command's header for the quota reasoning; the short version is that
 * `messages.get` costs 20 units however few headers you ask for, which is why
 * `pendingRecipientWhere` is as narrow as it is.
 */

import { db, and, eq, inArray, isNull, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { emails } from "@repo/database/models/emails";

import { withGmailRetry } from "../gmail/retry.ts";
import { corsair } from "@repo/corsair";

/** Gmail prices the method, not the payload. */
export const MESSAGES_GET_UNITS = 20;

const PAGE_SIZE = 200;
const CONCURRENCY = 8;

/** The only views that render a recipient. */
const RECIPIENT_VIEWS = ["SENT", "DRAFT"] as const;

/** Gmail treats a permanently-gone message as 404/410. */
function isGone(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 404 || status === 410;
}

/**
 * Rows that have to be asked of Gmail: a Sent/Draft row with no stored
 * recipient AND no hydrated `emails.to` for the read path to fall back on. The
 * NOT EXISTS is what stops the job paying 20 units for a header the UI can
 * already display.
 */
export function pendingRecipientWhere(userId: string) {
  return and(
    eq(messageMetadata.userId, userId),
    inArray(messageMetadata.category, [...RECIPIENT_VIEWS] as any[]),
    isNull(messageMetadata.recipient),
    sql`NOT EXISTS (
      SELECT 1 FROM ${emails}
      WHERE ${emails.gmailMessageId} = ${messageMetadata.entityId}
        AND ${emails.to} IS NOT NULL
    )`,
  );
}

export interface RecipientBackfillEstimate {
  rows: number;
  units: number;
}

/** Read-only. Safe to call as often as you like; costs one indexed count. */
export async function estimateRecipientBackfill(
  userId: string,
): Promise<RecipientBackfillEstimate> {
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messageMetadata)
    .where(pendingRecipientWhere(userId));

  return { rows: count, units: count * MESSAGES_GET_UNITS };
}

export interface RecipientBackfillResult {
  processed: number;
  stored: number;
  noHeader: number;
  gone: number;
  failed: number;
  errors: string[];
}

/**
 * Backfill one mailbox.
 *
 * Resumable by construction: the cursor is "still pending", so rows leave the
 * result set as they are filled and a re-run resumes exactly where it stopped.
 * A partial run is never wasted and re-running is always safe.
 */
export async function runRecipientBackfill(
  userId: string,
  opts: {
    dryRun?: boolean;
    limit?: number;
    /** Called after each page, so a long run can report progress as it goes. */
    onProgress?: (soFar: RecipientBackfillResult) => Promise<void> | void;
  } = {},
): Promise<RecipientBackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const limit = opts.limit ?? Infinity;

  const tenant = corsair.withTenant(userId);
  const result: RecipientBackfillResult = {
    processed: 0,
    stored: 0,
    noHeader: 0,
    gone: 0,
    failed: 0,
    errors: [],
  };

  while (result.processed < limit) {
    const batch = await db
      .select({ entityId: messageMetadata.entityId })
      .from(messageMetadata)
      .where(pendingRecipientWhere(userId))
      .limit(Math.min(PAGE_SIZE, limit - result.processed));

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
                metadataHeaders: ["To"],
              } as Parameters<typeof tenant.gmail.api.messages.get>[0]),
            { tenantId: userId, trigger: "sync" },
          )) as unknown as {
            payload?: { headers?: Array<{ name?: string; value?: string }> };
          };

          const to = msg.payload?.headers?.find(
            (h) => h.name?.toLowerCase() === "to",
          )?.value;

          if (!to) {
            result.noHeader++;
            // Sentinel so the pending cursor drains — otherwise every future
            // run re-fetches the same header-less messages forever. Empty
            // string reads as "asked, and there is none", which the UI renders
            // exactly like NULL.
            if (!dryRun) {
              await db
                .update(messageMetadata)
                .set({ recipient: "" })
                .where(eq(messageMetadata.entityId, entityId));
            }
            continue;
          }

          if (!dryRun) {
            await db
              .update(messageMetadata)
              .set({ recipient: to })
              .where(eq(messageMetadata.entityId, entityId));
          }
          result.stored++;
        } catch (error) {
          if (isGone(error)) {
            result.gone++;
            if (!dryRun) {
              await db
                .update(messageMetadata)
                .set({ recipient: "" })
                .where(eq(messageMetadata.entityId, entityId));
            }
            continue;
          }
          result.failed++;
          const message = error instanceof Error ? error.message : String(error);
          // Capped: one dead mailbox would otherwise produce an identical
          // message per row and make the audit row unreadable.
          if (result.errors.length < 5) result.errors.push(`${entityId}: ${message}`);
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    result.processed += batch.length;
    await opts.onProgress?.(result);

    // A dry run writes nothing, so the same page would come back forever. One
    // page is enough to see what it would do.
    if (dryRun) break;
  }

  return result;
}
