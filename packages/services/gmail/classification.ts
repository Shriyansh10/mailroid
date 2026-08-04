import { randomUUID } from "node:crypto";
import { db, eq, and, lt, gte, inArray, notInArray, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { classificationJobs } from "@repo/database/models/classification-jobs";
import { classifyEmailPriorityBatch, applyProfileOverrides, withAiUsage } from "@repo/ai";
import type { PriorityBatchItem, PriorityBatchResult } from "@repo/ai";
import { getClassificationContext } from "../profile/index.ts";
import { checkDailyLimit, incrementDailyLimitBy, refundDailyLimit } from "../usage-limits.ts";
import { logger } from "@repo/logger";

// One Inngest run processes exactly one batch of this many emails, split
// into LLM_BATCH_SIZE-sized prompts. Keeping a "batch" (the DB unit) larger
// than an "LLM batch" (the prompt unit) means one wasted DB round trip for
// the increment/apply steps buys 2 LLM calls instead of 1.
export const BATCH_SIZE = 100;
export const LLM_BATCH_SIZE = 50;

// ── Credit cost ──────────────────────────────────────────────────────
//
// Bulk classification consumes 1 daily-action credit per 1,000 emails
// (rounded up), charged once at job-start time and never trued up as the
// job runs. Everywhere this ratio is needed goes through these two
// functions — nothing else multiplies/divides by 1000 directly, so changing
// the ratio later is a two-function edit, not a repo-wide search.
const EMAILS_PER_CLASSIFICATION_CREDIT = 1000;
function creditsForEmails(count: number): number {
  return Math.ceil(count / EMAILS_PER_CLASSIFICATION_CREDIT);
}
function emailsCoveredByCredits(credits: number): number {
  return credits * EMAILS_PER_CLASSIFICATION_CREDIT;
}

export interface ClassificationCostEstimate {
  pendingCount: number;
  remainingCredits: number;
  /** True when pendingCount exceeds what remainingCredits can cover. */
  capped: boolean;
  /** How many emails will actually be classified — equals pendingCount unless capped. */
  cappedCount: number;
  /** What will actually be charged if this estimate is acted on. 0 when noCredits. */
  creditsToCharge: number;
  noCredits: boolean;
}

/**
 * Pure credit-planning logic given an already-known pending count. Split out
 * from estimateClassificationCost below so retryFailedClassifications (whose
 * "pending" count comes from resetting FAILED rows, not countPendingForScope
 * — those rows aren't PENDING yet at estimate time) can reuse the exact same
 * formula the tRPC preview and startClassificationJob use, without forcing a
 * countPendingForScope call that would undercount for the retry case.
 */
export async function computeCreditPlan(
  pendingCount: number,
  userId: string,
  userEmail?: string,
  userTimeZone?: string,
): Promise<ClassificationCostEstimate> {
  const { actionCount, limit } = await checkDailyLimit(userId, userEmail, userTimeZone);
  const remainingCredits = limit - actionCount;

  if (remainingCredits <= 0) {
    return { pendingCount, remainingCredits: 0, capped: false, cappedCount: 0, creditsToCharge: 0, noCredits: true };
  }

  if (pendingCount <= emailsCoveredByCredits(remainingCredits)) {
    return {
      pendingCount,
      remainingCredits,
      capped: false,
      cappedCount: pendingCount,
      creditsToCharge: creditsForEmails(pendingCount),
      noCredits: false,
    };
  }

  return {
    pendingCount,
    remainingCredits,
    capped: true,
    cappedCount: emailsCoveredByCredits(remainingCredits),
    creditsToCharge: remainingCredits,
    noCredits: false,
  };
}

/** Credit plan for a scope-based job (last_week/last_month) — pendingCount comes from countPendingForScope. */
export async function estimateClassificationCost(
  userId: string,
  since: Date,
  userEmail?: string,
  userTimeZone?: string,
): Promise<ClassificationCostEstimate> {
  const pendingCount = await countPendingForScope(userId, since);
  return computeCreditPlan(pendingCount, userId, userEmail, userTimeZone);
}

// An email can never classify (e.g. no sender/subject/snippet at all) stays
// PENDING forever without this cap — every batch would re-select it and burn
// an LLM call on it indefinitely. At 3 failed attempts it's marked FAILED and
// stops being selected. See message-metadata.ts for why there's no
// PROCESSING state between PENDING and DONE/FAILED.
export const MAX_CLASSIFICATION_ATTEMPTS = 3;

/**
 * Categories that are never worth an LLM call.
 *
 * Spam and Bin are mail the user has already (or Gmail has already) judged,
 * a draft is the user's own unsent text, and Sent is a copy of what the user
 * themselves wrote — none of them can be "high priority correspondence", and
 * none of them belong in the priority inbox (getPriorityEmails/
 * getPriorityCounts in metadata.ts also exclude SENT from what's displayed,
 * so this list must match that exclusion or classification just burns LLM
 * calls on mail the UI would hide anyway). This matters beyond taste: spam
 * folders are large (tens of thousands of messages is normal), they sync as
 * PENDING like everything else, and without this filter the batch classifier
 * would work through the entire spam folder one paid LLM call at a time.
 */
const UNCLASSIFIABLE_CATEGORIES = ["SPAM", "TRASH", "DRAFT", "SENT"] as any[];

/** Shared by the batch selection query and the job-sizing count, so the number
 *  the UI promises and the rows the classifier actually takes cannot drift. */
function classifiablePredicate(userId: string, since: Date) {
  return and(
    eq(messageMetadata.userId, userId),
    eq(messageMetadata.classificationStatus, "PENDING"),
    lt(messageMetadata.classificationAttempts, MAX_CLASSIFICATION_ATTEMPTS),
    gte(messageMetadata.receivedAt, since),
    notInArray(messageMetadata.category, UNCLASSIFIABLE_CATEGORIES),
  );
}

// "retry_failed" has no fixed window — its date range comes from where the
// failed rows actually sit, so it always carries an explicit `since`.
export type ClassificationScope = "last_week" | "last_month" | "retry_failed";

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
    .where(classifiablePredicate(userId, since));
  return Number(row?.count ?? 0);
}

/**
 * Emails that exhausted MAX_CLASSIFICATION_ATTEMPTS and will never be picked
 * up again by any job.
 *
 * Deliberately NOT scoped by date. These rows are invisible to every other
 * count in the product: the "Unclassified" tab counts `priority IS NULL`,
 * while job sizing counts PENDING-and-under-the-cap. A FAILED row satisfies
 * the first and not the second, so the UI offers to classify emails the
 * backend then refuses — which surfaces as "Nothing to classify in that range"
 * with no explanation. This is the number that explains the gap.
 */
export async function countFailedClassifications(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.classificationStatus, "FAILED"),
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
    .where(classifiablePredicate(userId, since))
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
          matchedSignals: result.matchedSignals,
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
  /** True once this job has attempted maxToProcess emails — the caller must not continue. */
  capReached: boolean;
}

/** { maxToProcess, attemptedCount } for a job — read fresh each batch run so a cap survives reconciliation-cron re-triggers. */
async function getJobBudget(jobId: string): Promise<{ maxToProcess: number | null; attemptedCount: number }> {
  const [row] = await db
    .select({ maxToProcess: classificationJobs.maxToProcess, attemptedCount: classificationJobs.attemptedCount })
    .from(classificationJobs)
    .where(eq(classificationJobs.id, jobId))
    .limit(1);
  return { maxToProcess: row?.maxToProcess ?? null, attemptedCount: row?.attemptedCount ?? 0 };
}

async function incrementAttemptedCount(jobId: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await db
    .update(classificationJobs)
    .set({ attemptedCount: sql`${classificationJobs.attemptedCount} + ${delta}`, updatedAt: new Date() })
    .where(eq(classificationJobs.id, jobId));
}

/**
 * Runs exactly one batch: select up to BATCH_SIZE PENDING emails — or fewer,
 * if this job has a credit cap (maxToProcess) and is close to it — classify
 * them (LLM_BATCH_SIZE per prompt), apply what validates, and report how
 * many PENDING emails are left for this job's scope so the caller knows
 * whether to continue or mark the job complete.
 */
export async function runClassificationBatch(
  userId: string,
  since: Date,
  jobId: string,
): Promise<ClassificationBatchOutcome> {
  const { maxToProcess, attemptedCount } = await getJobBudget(jobId);
  const budget = maxToProcess == null ? BATCH_SIZE : Math.max(0, Math.min(BATCH_SIZE, maxToProcess - attemptedCount));

  if (budget === 0) {
    // Already attempted everything this job's credits paid for — nothing more
    // to do, whatever else may still be PENDING in the window stays for a
    // future job/day.
    return { attempted: 0, classified: 0, remaining: 0, capReached: true };
  }

  const batch = await selectPendingBatch(userId, since, budget);
  if (batch.length === 0) {
    return { attempted: 0, classified: 0, remaining: 0, capReached: false };
  }

  // One (cached) profile read covers the whole batch. Null for users who
  // never saved a profile — classification then behaves exactly as before
  // personalization existed.
  const userContext = await getClassificationContext(userId);

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
      const chunkResults = await withAiUsage({ userId }, () =>
        classifyEmailPriorityBatch(chunk, userContext?.context),
      );
      // Muted senders are a hard rule applied in code, whatever the LLM said.
      allResults.push(
        ...chunkResults.map((r) => ({
          ...r,
          ...applyProfileOverrides(
            batch[r.index]?.sender ?? "",
            r,
            userContext ?? undefined,
          ),
        })),
      );
    } catch (err) {
      // An exhausted quota is not a transient chunk failure — every remaining
      // chunk will fail the same way. Aborting the batch stops it burning an
      // attempt on each of the other chunks' rows, which would otherwise mark
      // hundreds of perfectly classifiable emails FAILED at
      // MAX_CLASSIFICATION_ATTEMPTS for a reason that had nothing to do with
      // them. Rows already applied above keep their results.
      if ((err as { code?: string })?.code === "insufficient_quota") {
        logger.error("[CLASSIFY] provider quota exhausted, aborting batch", { userId });
        throw err;
      }
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

  const newAttemptedCount = attemptedCount + entityIds.length;
  await incrementAttemptedCount(jobId, entityIds.length);

  const rawRemaining = await countPendingForScope(userId, since);
  // Clamp what this batch reports as "remaining" to the job's own budget, not
  // the whole window — rawRemaining counts every PENDING email in the date
  // range regardless of whether this job is allowed to touch them. Without
  // this, setJobProgress's GREATEST(totalCount, remaining) growth logic
  // (meant to let the progress bar's denominator grow when mail arrives
  // mid-job) would grow totalCount past the credit cap.
  const capReached = maxToProcess != null && newAttemptedCount >= maxToProcess;
  const remaining =
    maxToProcess == null ? rawRemaining : Math.min(rawRemaining, Math.max(0, maxToProcess - newAttemptedCount));

  logger.info("[CLASSIFY] batch completed", {
    userId, attempted: entityIds.length, classified: allResults.length, remaining, capReached,
  });

  return { attempted: entityIds.length, classified: allResults.length, remaining, capReached };
}

// ── Job bookkeeping ──────────────────────────────────────────────────

/**
 * `costEstimate` must come from `estimateClassificationCost`/`computeCreditPlan` —
 * the credits for this job were already charged by the caller against that
 * exact estimate, so `totalCount`/`maxToProcess` here must match it exactly
 * rather than re-deriving a (possibly different, if mail arrived in between)
 * pending count.
 */
export async function createClassificationJob(
  userId: string,
  scope: ClassificationScope,
  // Retry passes this: its window is defined by where the failed rows actually
  // are, which is older than any fixed scope would give.
  sinceOverride: Date | undefined,
  costEstimate: ClassificationCostEstimate,
): Promise<{ id: string; totalCount: number; since: Date } | { alreadyRunning: true }> {
  const since = sinceOverride ?? scopeToSinceDate(scope);
  const totalCount = costEstimate.cappedCount;
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
      maxToProcess: costEstimate.capped ? costEstimate.cappedCount : null,
      creditsCharged: costEstimate.creditsToCharge,
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
  | { started: true; jobId: string; totalCount: number; capped: boolean; cappedCount: number; creditsCharged: number }
  | { started: false; reason: "already_running" | "no_credits" | "credits_changed" }
  | { started: true; jobId: null; totalCount: 0; capped: false; cappedCount: 0; creditsCharged: 0 }; // nothing pending for this scope

/**
 * Creates the job row and fires its first batch event, mirroring
 * triggerGmailSync's own pattern of owning its trigger rather than leaving
 * the caller (tRPC route) to send the event itself.
 *
 * Also fires email/hydrate.requested for the SAME window, independently of
 * classification's own alreadyRunning/totalCount guards — hydration is
 * decoupled on purpose (see hydrate-batch.ts): it has its own PENDING rows
 * to check regardless of whether classification has anything left to
 * classify. One correlationId ties classification, hydration, and the
 * indexing it triggers back to this single click, purely for tracing —
 * none of the three pipelines depend on it functionally.
 */
export async function startClassificationJob(
  userId: string,
  scope: ClassificationScope,
  userEmail?: string,
  userTimeZone?: string,
): Promise<StartClassificationJobResult> {
  const since = scopeToSinceDate(scope);

  // Credit check happens before anything else, including the hydrate event
  // below — a call that can't actually start a job shouldn't have side
  // effects.
  const estimate = await estimateClassificationCost(userId, since, userEmail, userTimeZone);
  if (estimate.noCredits) {
    return { started: false, reason: "no_credits" };
  }

  if (estimate.pendingCount === 0) {
    return { started: true, jobId: null, totalCount: 0, capped: false, cappedCount: 0, creditsCharged: 0 };
  }

  // Charge once, up front, against exactly this estimate — never trued up
  // later even if the actual pending count drifts while the job runs.
  const charged = await incrementDailyLimitBy(userId, userEmail, userTimeZone, estimate.creditsToCharge);
  if (!charged) {
    // A concurrent request (a second tab, a double-click) consumed the
    // remaining credits between the estimate read above and this row-locked
    // write. Don't create a job on a charge that didn't land — the caller
    // should re-fetch the estimate and let the user decide again with fresh
    // numbers.
    return { started: false, reason: "credits_changed" };
  }

  const correlationId = randomUUID();

  const { inngest } = await import("@repo/inngest");
  await inngest.send({
    name: "email/hydrate.requested",
    data: { userId, since: since.toISOString(), correlationId },
  });

  const job = await createClassificationJob(userId, scope, since, estimate);
  if ("alreadyRunning" in job) {
    // We already charged above. The job losing the race for the
    // one-active-job-per-user constraint means this charge paid for nothing
    // — give it back rather than silently keep it.
    await refundDailyLimit(userId, userEmail, userTimeZone, estimate.creditsToCharge);
    return { started: false, reason: "already_running" };
  }

  if (job.totalCount === 0) {
    await markJobComplete(job.id);
    return { started: true, jobId: null, totalCount: 0, capped: false, cappedCount: 0, creditsCharged: 0 };
  }

  await inngest.send({
    name: "classification/batch.requested",
    data: { jobId: job.id, userId, since: job.since.toISOString(), correlationId },
  });
  logger.info("[CLASSIFY] job started", {
    userId, scope, jobId: job.id, totalCount: job.totalCount,
    capped: estimate.capped, creditsCharged: estimate.creditsToCharge, correlationId,
  });

  return {
    started: true,
    jobId: job.id,
    totalCount: job.totalCount,
    capped: estimate.capped,
    cappedCount: estimate.cappedCount,
    creditsCharged: estimate.creditsToCharge,
  };
}

export type RetryFailedResult =
  | { started: true; jobId: string; totalCount: number; resetCount: number; capped: boolean; cappedCount: number; creditsCharged: number }
  | { started: false; reason: "already_running" | "no_credits" | "credits_changed" }
  | { started: true; jobId: null; totalCount: 0; resetCount: 0; capped: false; cappedCount: 0; creditsCharged: 0 }; // nothing failed

/**
 * Clears the attempt cap on FAILED emails and starts a job over them.
 *
 * The cap exists to stop an *automatic* loop burning credit on rows that can
 * never classify. A button press is not that loop — it's a person deciding the
 * original cause (an exhausted quota, a provider outage) is fixed. So resetting
 * attempts here is the intended escape hatch, not a bypass.
 *
 * `since` is the oldest failed row rather than a fixed window: these rows can
 * be arbitrarily old, and a last_week/last_month job would silently skip the
 * very emails the user clicked retry to rescue.
 *
 * Costed the same as scope-based jobs (1 credit per 1,000 emails) — otherwise
 * a user capped out on "Classify Last Month" could get unlimited extra
 * classification for free through Retry.
 */
export async function retryFailedClassifications(
  userId: string,
  userEmail?: string,
  userTimeZone?: string,
): Promise<RetryFailedResult> {
  const [oldest] = await db
    .select({ receivedAt: messageMetadata.receivedAt })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.classificationStatus, "FAILED"),
      ),
    )
    .orderBy(sql`${messageMetadata.receivedAt} ASC`)
    .limit(1);

  if (!oldest?.receivedAt) {
    return { started: true, jobId: null, totalCount: 0, resetCount: 0, capped: false, cappedCount: 0, creditsCharged: 0 };
  }

  const failedCount = await countFailedClassifications(userId);
  const estimate = await computeCreditPlan(failedCount, userId, userEmail, userTimeZone);
  if (estimate.noCredits) {
    return { started: false, reason: "no_credits" };
  }

  // Which failed rows this job will actually retry — the oldest cappedCount
  // of them, so a credit-capped retry rescues the longest-stuck emails
  // first. Selected (not reset) before charging, so a rejected charge never
  // mutates any row.
  const targets = await db
    .select({ entityId: messageMetadata.entityId })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.classificationStatus, "FAILED"),
      ),
    )
    .orderBy(sql`${messageMetadata.receivedAt} ASC`)
    .limit(estimate.cappedCount);
  const targetIds = targets.map((t) => t.entityId);

  const charged = await incrementDailyLimitBy(userId, userEmail, userTimeZone, estimate.creditsToCharge);
  if (!charged) {
    return { started: false, reason: "credits_changed" };
  }

  // Reset before sizing the job — createClassificationJob takes totalCount
  // straight from `estimate`, but the rows themselves must actually be
  // PENDING before the first batch runs, or it would select nothing.
  const reset = await db
    .update(messageMetadata)
    .set({ classificationStatus: "PENDING", classificationAttempts: 0, updatedAt: new Date() })
    .where(
      and(
        eq(messageMetadata.userId, userId),
        inArray(messageMetadata.entityId, targetIds),
      ),
    )
    .returning({ entityId: messageMetadata.entityId });

  const since = new Date(oldest.receivedAt);
  const job = await createClassificationJob(userId, "retry_failed", since, estimate);

  if ("alreadyRunning" in job) {
    // The rows stay PENDING, so this isn't lost work — the in-flight job picks
    // them up if its own window covers them, and otherwise the next retry
    // click starts a job that does. But the charge above paid for a job that
    // didn't happen, so give it back.
    await refundDailyLimit(userId, userEmail, userTimeZone, estimate.creditsToCharge);
    logger.info("[CLASSIFY] retry reset rows but a job is already running", {
      userId, resetCount: reset.length,
    });
    return { started: false, reason: "already_running" };
  }

  if (job.totalCount === 0) {
    await markJobComplete(job.id);
    return { started: true, jobId: null, totalCount: 0, resetCount: 0, capped: false, cappedCount: 0, creditsCharged: 0 };
  }

  const { inngest } = await import("@repo/inngest");
  await inngest.send({
    name: "classification/batch.requested",
    data: { jobId: job.id, userId, since: job.since.toISOString() },
  });
  logger.info("[CLASSIFY] retry job started", {
    userId, jobId: job.id, totalCount: job.totalCount, resetCount: reset.length,
    capped: estimate.capped, creditsCharged: estimate.creditsToCharge,
  });

  return {
    started: true,
    jobId: job.id,
    totalCount: job.totalCount,
    resetCount: reset.length,
    capped: estimate.capped,
    cappedCount: estimate.cappedCount,
    creditsCharged: estimate.creditsToCharge,
  };
}

// ── Priority-tab classify controls ───────────────────────────────────

/**
 * Everything the priority tab's classify controls need in one call.
 *
 * hasClassified is derived from classification_jobs rather than a stored
 * flag: a scoped (last_week/last_month) job that is running or complete
 * means the user has spent their one-time classification — the scope
 * buttons never render again. A job that outright FAILED doesn't count, so
 * a provider outage on the very first run doesn't lock the buttons forever.
 *
 * remainingUnclassified counts emails in the classified job's own window
 * (its persisted `since`, not a recomputed one) that still have no
 * priority — the signal for showing the Retry button.
 */
export async function getClassifyControlsStatus(userId: string): Promise<{
  hasClassified: boolean;
  remainingUnclassified: number;
  failedCount: number;
}> {
  const [job] = await db
    .select({
      since: classificationJobs.since,
    })
    .from(classificationJobs)
    .where(
      and(
        eq(classificationJobs.userId, userId),
        inArray(classificationJobs.scope, ["last_week", "last_month"]),
        inArray(classificationJobs.status, ["running", "complete"]),
      ),
    )
    .orderBy(sql`${classificationJobs.startedAt} DESC`)
    .limit(1);

  const failedCount = await countFailedClassifications(userId);

  if (!job) {
    return { hasClassified: false, remainingUnclassified: 0, failedCount };
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        sql`${messageMetadata.priority} IS NULL`,
        gte(messageMetadata.receivedAt, job.since),
      ),
    );

  return {
    hasClassified: true,
    remainingUnclassified: Number(row?.count ?? 0),
    failedCount,
  };
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

/**
 * Records progress from what the DB actually says is left, rather than
 * accumulating each batch's attempted count.
 *
 * Accumulating over-counted badly: a row whose LLM chunk failed stays PENDING
 * by design, gets re-selected by the next batch, and was counted again each
 * time — so processed_count tracked *attempts*, not emails, and could reach
 * total_count × MAX_CLASSIFICATION_ATTEMPTS. A run against an exhausted API
 * quota reported "1,800 / 855" while classifying nothing.
 *
 * `remaining` is a fresh countPendingForScope, so deriving from it is
 * self-correcting: retries no longer inflate it, and a lost continuation event
 * that the reconciliation cron re-kicks resumes at the true figure.
 *
 * Both expressions read the pre-UPDATE total_count, so they stay consistent
 * within the statement. GREATEST covers mail arriving mid-job, which can push
 * `remaining` above the total snapshotted at job start — the total grows to fit
 * instead of the progress bar running backwards or going negative.
 */
export async function setJobProgress(jobId: string, remaining: number): Promise<void> {
  await db
    .update(classificationJobs)
    .set({
      totalCount: sql`GREATEST(${classificationJobs.totalCount}, ${remaining})`,
      processedCount: sql`GREATEST(${classificationJobs.totalCount}, ${remaining}) - ${remaining}`,
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
