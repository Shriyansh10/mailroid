import { db, eq, and, isNull, gte } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { classifyEmailPriority } from "@repo/ai";
import { logger } from "@repo/logger";

export async function backfillPriorityEmails(opts?: {
  days?: number;
  batchSize?: number;
  maxToProcess?: number;
}): Promise<{ processedCount: number; successCount: number; errorCount: number }> {
  const days = opts?.days ?? 30;
  const batchSize = opts?.batchSize ?? 50;
  const maxToProcess = opts?.maxToProcess ?? 50; // default safety limit

  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - days);

  logger.info("[BACKFILL] Starting priority backfill service", {
    days,
    batchSize,
    maxToProcess,
    thresholdDate: thresholdDate.toISOString(),
  });

  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;
  let hasMore = true;

  while (hasMore) {
    logger.info(`[BACKFILL] Querying next batch of up to ${batchSize} unclassified emails...`);
    const records = await db
      .select({
        entityId: messageMetadata.entityId,
        userId: messageMetadata.userId,
        sender: messageMetadata.sender,
        subject: messageMetadata.subject,
        snippet: messageMetadata.snippet,
        createdAt: messageMetadata.createdAt,
      })
      .from(messageMetadata)
      .where(
        and(
          isNull(messageMetadata.priorityScore),
          gte(messageMetadata.createdAt, thresholdDate)
        )
      )
      .limit(batchSize);

    if (records.length === 0) {
      logger.info("[BACKFILL] No more unclassified emails found in date range.");
      hasMore = false;
      break;
    }

    logger.info(`[BACKFILL] Processing batch of ${records.length} emails...`);

    for (const record of records) {
      if (processedCount >= maxToProcess) {
        logger.info(`[BACKFILL] Reached maxToProcess limit of ${maxToProcess}. Stopping.`);
        hasMore = false;
        break;
      }
      processedCount++;
      const { entityId, sender, subject, snippet } = record;
      logger.info(`[BACKFILL] Classifying email ${processedCount}: ${subject || "(No Subject)"} from ${sender || "Unknown"}`);

      try {
        const classification = await classifyEmailPriority(
          sender || "Unknown Sender",
          subject || "No Subject",
          snippet || "No Content"
        );

        // classifyEmailPriority throws on failure now (rate limit, malformed
        // output, network error) instead of returning null — the catch below
        // is what counts a failed email, so there's no separate null branch.
        await db
          .update(messageMetadata)
          .set({
            priority: classification.priority,
            priorityScore: classification.priorityScore,
            priorityReason: classification.priorityReason,
            isActionRequired: classification.isActionRequired,
            isReplyNeeded: classification.isReplyNeeded,
            classificationStatus: "DONE",
            lastClassifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(messageMetadata.entityId, entityId));

        successCount++;
        logger.info(`[BACKFILL] Successfully updated classification to ${classification.priority} (Score: ${classification.priorityScore})`);
      } catch (err) {
        errorCount++;
        logger.error(`[BACKFILL] Failed to process email ${entityId}:`, err);
      }
    }

    // Stop if we fetched less than the batch size (it was the last batch)
    if (records.length < batchSize) {
      hasMore = false;
    }
  }

  logger.info("[BACKFILL] Priority backfill completed", {
    processedCount,
    successCount,
    errorCount,
  });

  return { processedCount, successCount, errorCount };
}

// Support running this script directly using tsx
if (import.meta.url.startsWith("file:") && process.argv[1] && (
  process.argv[1].endsWith("backfill-priority.ts") || 
  process.argv[1].endsWith("backfill-priority.js")
)) {
  backfillPriorityEmails({ days: 30, batchSize: 50, maxToProcess: 100 })
    .then((res) => {
      console.log("Backfill script finished successfully:", res);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Backfill script encountered error:", err);
      process.exit(1);
    });
}
