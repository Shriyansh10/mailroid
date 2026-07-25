import { db, eq, and, gte, notInArray, inArray, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { emails } from "@repo/database/models/emails";
import { classificationJobs } from "@repo/database/models/classification-jobs";
import { aiSetupStatus } from "@repo/database/models/ai-setup-status";
import { logger } from "@repo/logger";
import { countPendingHydration } from "./hydration.ts";

// Same list classification.ts skips — these categories never enter the AI
// pipeline at all, so they don't belong in the hydration/indexing denominator.
const UNCLASSIFIABLE_CATEGORIES = ["SPAM", "TRASH", "DRAFT", "SENT"] as any[];

export interface AiSetupProgress {
  classification: { done: number; total: number };
  hydration: { done: number; total: number };
  indexing: { done: number; total: number };
}

export interface AiReadiness {
  ready: boolean;
  /** Only meaningful while ready === false — the live progress driving the
   *  setup UI. Once latched, there's nothing left to show, so this is null. */
  setup: AiSetupProgress | null;
}

/**
 * `ready` is a persisted, write-once latch (ai_setup_status.completed_at),
 * not a live "is everything drained right now" check. Once set, it is
 * returned immediately and NEVER recomputed — ordinary webhook mail arriving
 * later is briefly un-hydrated/un-indexed by nature, and if `ready` were
 * live it would flicker false on every new email, disabling Dobbie for an
 * established user. See the model comment on ai-setup-status.ts.
 *
 * While the latch isn't set yet, this computes live progress for the user's
 * one scoped classify window (last_week/last_month — the only source of an
 * initial AI setup) and, if classification + hydration + indexing have all
 * actually drained for that window, sets the latch on this very call. That
 * makes latching self-healing under polling: the UI already polls this query
 * every ~10s while ready === false, so there's no need for a separate
 * "did all three pipelines finish" coordinator across three independent
 * Inngest functions — the next poll after the last one drains just notices.
 */
export async function getAiReadiness(userId: string): Promise<AiReadiness> {
  const [latch] = await db
    .select({ completedAt: aiSetupStatus.completedAt })
    .from(aiSetupStatus)
    .where(eq(aiSetupStatus.userId, userId))
    .limit(1);

  if (latch?.completedAt) {
    return { ready: true, setup: null };
  }

  const [job] = await db
    .select({
      since: classificationJobs.since,
      status: classificationJobs.status,
      processedCount: classificationJobs.processedCount,
      totalCount: classificationJobs.totalCount,
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

  if (!job) {
    // No scoped classify job has ever run — initial setup hasn't started.
    return {
      ready: false,
      setup: {
        classification: { done: 0, total: 0 },
        hydration: { done: 0, total: 0 },
        indexing: { done: 0, total: 0 },
      },
    };
  }

  const since = job.since;
  const classificationDone = job.status === "complete";

  const hydrationRemaining = await countPendingHydration(userId, since);
  const [hydrationTotalRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        gte(messageMetadata.receivedAt, since),
        notInArray(messageMetadata.category, UNCLASSIFIABLE_CATEGORIES),
      ),
    );
  const hydrationTotal = Number(hydrationTotalRow?.total ?? 0);
  const hydrationDone = Math.max(0, hydrationTotal - hydrationRemaining);
  const hydrationDrained = hydrationRemaining === 0;

  // Indexing's own denominator is hydrated rows in the window (bodyText not
  // null), not the classification/hydration total — an email that failed
  // hydration permanently can never be embedded, and shouldn't hold the
  // indexing bar (or the latch) back forever.
  const [indexRow] = await db
    .select({
      total: sql<number>`count(*) filter (where ${emails.bodyText} is not null)`,
      done: sql<number>`count(*) filter (where ${emails.embedding} is not null)`,
    })
    .from(emails)
    .where(and(eq(emails.userId, userId), gte(emails.receivedAt, since)));
  const indexingTotal = Number(indexRow?.total ?? 0);
  const indexingDone = Number(indexRow?.done ?? 0);
  const indexingDrained = indexingDone >= indexingTotal;

  const drained = classificationDone && hydrationDrained && indexingDrained;

  if (drained) {
    await db
      .insert(aiSetupStatus)
      .values({ userId, completedAt: new Date() })
      .onConflictDoUpdate({
        target: aiSetupStatus.userId,
        // Never clobber an already-set latch — this branch only runs when we
        // just read it as unset, but two concurrent pollers can both observe
        // "drained" in the same instant.
        set: {
          completedAt: sql`coalesce(${aiSetupStatus.completedAt}, excluded.completed_at)`,
          updatedAt: new Date(),
        },
      });
    logger.info("[AI_READY] initial AI setup completed, latching", { userId });
    return { ready: true, setup: null };
  }

  return {
    ready: false,
    setup: {
      classification: { done: job.processedCount, total: job.totalCount },
      hydration: { done: hydrationDone, total: hydrationTotal },
      indexing: { done: indexingDone, total: indexingTotal },
    },
  };
}
