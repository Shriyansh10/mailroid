import { db, eq, and, lt, gte, inArray, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { classificationJobs } from "@repo/database/models/classification-jobs";
import { classifyEmailPriorityBatch } from "@repo/ai";
import type { PriorityBatchItem, PriorityBatchResult } from "@repo/ai";
import { logger } from "@repo/logger";

// One Inngest run processes exactly one batch of this many emails, split
// into LLM_BATCH_SIZE-sized prompts. Keeping a "batch" (the DB unit) larger
// than an "LLM batch" (the prompt unit) means one wasted DB round trip for
// the increment/apply steps buys 2 LLM calls instead of 1.
export const BATCH_SIZE = 100;
export const LLM_BATCH_SIZE = 50;

// An email can never classify (e.g. no sender/subject/snippet at all) stays
// PENDING forever without this cap — every batch would re-select it and burn
// an LLM call on it indefinitely. At 3 failed attempts it's marked FAILED and
// stops being selected. See message-metadata.ts for why there's no
// PROCESSING state between PENDING and DONE/FAILED.
export const MAX_CLASSIFICATION_ATTEMPTS = 3;

export type ClassificationScope = "last_week" | "last_month";

export function scopeToSinceDate(scope: ClassificationScope): Date {
  const d = new Date();
  if (scope === "last_week") d.setDate(d.getDate() - 7);
  else d.setMonth(d.getMonth() - 1);
  return d;
}

/** Same predicate as the batch selection query — used to size a new job. */
export async function countPendingForScope(userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.classificationStatus, "PENDING"),
        lt(messageMetadata.classificationAttempts, MAX_CLASSIFICATION_ATTEMPTS),
        gte(messageMetadata.receivedAt, since),
      ),
    );
  return Number(row?.count ?? 0);
}

interface PendingRow {
  entityId: string;
  sender: string | null;
  subject: string | null;
  snippet: string | null;
}

async function selectPendingBatch(
  userId: string,
  since: Date,
  limit: number,
): Promise<PendingRow[]> {
  return db
    .select({
      entityId: messageMetadata.entityId,
      sender: messageMetadata.sender,
      subject: messageMetadata.subject,
      snippet: messageMetadata.snippet,
    })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.classificationStatus, "PENDING"),
        lt(messageMetadata.classificationAttempts, MAX_CLASSIFICATION_ATTEMPTS),
        gte(messageMetadata.receivedAt, since),
      ),
    )
    .orderBy(sql`${messageMetadata.receivedAt} DESC`)
    .limit(limit);
}

/** Bumped when a batch STARTS, not when it succeeds — see MAX_CLASSIFICATION_ATTEMPTS. */
async function incrementAttempts(entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;
  await db
    .update(messageMetadata)
    .set({ classificationAttempts: sql`${messageMetadata.classificationAttempts} + 1` })
    .where(inArray(messageMetadata.entityId, entityIds));
}

/**
 * Applies validated results. Conditioned on classification_status = 'PENDING'
 * so a webhook that classified this same email in the meantime (its own
 * pipeline, running independently) doesn't get overwritten by a bulk batch
 * that selected it a moment earlier.
 */
async function applyBatchResults(
  entityIds: string[],
  results: PriorityBatchResult[],
): Promise<void> {
  const CONCURRENCY = 10;
  let cursor = 0;

  async function worker() {
    while (cursor < results.length) {
      const result = results[cursor++]!;
      const entityId = entityIds[result.index];
      if (!entityId) continue;

      await db
        .update(messageMetadata)
        .set({
          priority: result.priority,
          priorityScore: result.priorityScore,
          priorityReason: result.priorityReason,
          isActionRequired: result.isActionRequired,
          isReplyNeeded: result.isReplyNeeded,
          classificationStatus: "DONE",
          lastClassifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(messageMetadata.entityId, entityId),
            eq(messageMetadata.classificationStatus, "PENDING"),
          ),
        );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, results.length) }, () => worker()),
  );
}

/** Rows the LLM never returned a valid result for. FAILED once attempts are exhausted, else left PENDING for a later batch. */
async function finalizeUnclassified(entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;
  await db
    .update(messageMetadata)
    .set({ classificationStatus: "FAILED", updatedAt: new Date() })
    .where(
      and(
        inArray(messageMetadata.entityId, entityIds),
        eq(messageMetadata.classificationStatus, "PENDING"),
        sql`${messageMetadata.classificationAttempts} >= ${MAX_CLASSIFICATION_ATTEMPTS}`,
      ),
    );
}

export interface ClassificationBatchOutcome {
  attempted: number;
  classified: number;
  remaining: number;
}

/**
 * Runs exactly one batch: select up to BATCH_SIZE PENDING emails, classify
 * them (LLM_BATCH_SIZE per prompt), apply what validates, and report how
 * many PENDING emails are left for this job's scope so the caller knows
 * whether to continue or mark the job complete.
 */
export async function runClassificationBatch(
  userId: string,
  since: Date,
): Promise<ClassificationBatchOutcome> {
  const batch = await selectPendingBatch(userId, since, BATCH_SIZE);
  if (batch.length === 0) {
    return { attempted: 0, classified: 0, remaining: 0 };
  }

  const entityIds = batch.map((row) => row.entityId);
  await incrementAttempts(entityIds);

  const items: PriorityBatchItem[] = batch.map((row, index) => ({
    index,
    sender: row.sender || "Unknown Sender",
    subject: row.subject || "No Subject",
    snippet: row.snippet || "No Content",
  }));

  const allResults: PriorityBatchResult[] = [];
  for (let i = 0; i < items.length; i += LLM_BATCH_SIZE) {
    const chunk = items.slice(i, i + LLM_BATCH_SIZE);
    try {
      const chunkResults = await classifyEmailPriorityBatch(chunk);
      allResults.push(...chunkResults);
    } catch (err) {
      // One bad LLM call must not block the OTHER chunk in this batch, and
      // must not throw away the sub-batch that DID succeed. These emails
      // simply stay PENDING (or become FAILED below, if attempts are now
      // exhausted) and get picked up by a later batch.
      logger.error("[CLASSIFY] LLM chunk failed, leaving pending for retry", {
        userId, chunkStart: i, chunkSize: chunk.length, error: String(err),
      });
    }
  }

  await applyBatchResults(entityIds, allResults);

  const classifiedEntityIds = new Set(allResults.map((r) => entityIds[r.index]));
  const unclassifiedEntityIds = entityIds.filter((id) => !classifiedEntityIds.has(id));
  await finalizeUnclassified(unclassifiedEntityIds);

  const remaining = await countPendingForScope(userId, since);

  logger.info("[CLASSIFY] batch completed", {
    userId, attempted: entityIds.length, classified: allResults.length, remaining,
  });

  return { attempted: entityIds.length, classified: allResults.length, remaining };
}

// ── Job bookkeeping ──────────────────────────────────────────────────

export async function createClassificationJob(
  userId: string,
  scope: ClassificationScope,
): Promise<{ id: string; totalCount: number; since: Date } | { alreadyRunning: true }> {
  const since = scopeToSinceDate(scope);
  const totalCount = await countPendingForScope(userId, since);
  const id = `${userId}-${Date.now()}`;

  try {
    await db.insert(classificationJobs).values({
      id,
      userId,
      scope,
      since,
      status: "running",
      totalCount,
      processedCount: 0,
    });
  } catch (err) {
    // Unique partial index (classification_jobs_one_active) rejects a second
    // concurrent 'running' job for this user — a double-click can't start
    // two continuation chains.
    logger.warn("[CLASSIFY] job insert rejected, likely already running", {
      userId, scope, error: String(err),
    });
    return { alreadyRunning: true };
  }

  return { id, totalCount, since };
}

export type StartClassificationJobResult =
  | { started: true; jobId: string; totalCount: number }
  | { started: false; reason: "already_running" }
  | { started: true; jobId: null; totalCount: 0 }; // nothing pending for this scope

/**
 * Creates the job row and fires its first batch event, mirroring
 * triggerGmailSync's own pattern of owning its trigger rather than leaving
 * the caller (tRPC route) to send the event itself.
 */
export async function startClassificationJob(
  userId: string,
  scope: ClassificationScope,
): Promise<StartClassificationJobResult> {
  const job = await createClassificationJob(userId, scope);
  if ("alreadyRunning" in job) {
    return { started: false, reason: "already_running" };
  }

  if (job.totalCount === 0) {
    await markJobComplete(job.id);
    return { started: true, jobId: null, totalCount: 0 };
  }

  const { inngest } = await import("@repo/inngest");
  await inngest.send({
    name: "classification/batch.requested",
    data: { jobId: job.id, userId, since: job.since.toISOString() },
  });
  logger.info("[CLASSIFY] job started", { userId, scope, jobId: job.id, totalCount: job.totalCount });

  return { started: true, jobId: job.id, totalCount: job.totalCount };
}

export async function getLatestClassificationJob(userId: string) {
  const [row] = await db
    .select()
    .from(classificationJobs)
    .where(eq(classificationJobs.userId, userId))
    .orderBy(sql`${classificationJobs.startedAt} DESC`)
    .limit(1);
  return row ?? null;
}

/** `delta` is this batch's attempted count — accumulated onto the job's running total, not overwritten. */
export async function incrementJobProgress(jobId: string, delta: number): Promise<void> {
  await db
    .update(classificationJobs)
    .set({
      processedCount: sql`${classificationJobs.processedCount} + ${delta}`,
      updatedAt: new Date(),
    })
    .where(eq(classificationJobs.id, jobId));
}

export async function markJobComplete(jobId: string): Promise<void> {
  await db
    .update(classificationJobs)
    .set({ status: "complete", updatedAt: new Date() })
    .where(eq(classificationJobs.id, jobId));
}

export async function markJobFailed(jobId: string): Promise<void> {
  await db
    .update(classificationJobs)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(classificationJobs.id, jobId));
}
