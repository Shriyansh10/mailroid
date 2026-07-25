import { db, eq, and, lt, gte, inArray, notInArray, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";
import { ingestMessage } from "./index.ts";

// One hydrate batch fetches up to this many message bodies. Same size as
// classification.ts's BATCH_SIZE — the two are independent (see the
// decoupling note in classification.ts), but there's no reason for the
// checkpoint granularity to differ.
export const HYDRATION_BATCH_SIZE = 100;

// Gmail quota is 250 units/sec/user; messages.get(format:"full") costs 5, so
// this stays well under the ceiling even with the classify batch (LLM-bound,
// not Gmail-bound) potentially running at the same time.
export const HYDRATION_CONCURRENCY = 5;

// Same reasoning as MAX_CLASSIFICATION_ATTEMPTS (classification.ts): without
// a cap, a row that can never hydrate (e.g. a transient error that recurs)
// would be re-selected by every batch forever.
export const MAX_HYDRATION_ATTEMPTS = 3;

// Spam/Bin/Draft/Sent are never worth a body fetch either — mirrors
// UNCLASSIFIABLE_CATEGORIES in classification.ts exactly.
const UNHYDRATABLE_CATEGORIES = ["SPAM", "TRASH", "DRAFT", "SENT"] as any[];

function hydratablePredicate(userId: string, since: Date) {
  return and(
    eq(messageMetadata.userId, userId),
    eq(messageMetadata.hydrationStatus, "PENDING"),
    lt(messageMetadata.hydrationAttempts, MAX_HYDRATION_ATTEMPTS),
    gte(messageMetadata.receivedAt, since),
    notInArray(messageMetadata.category, UNHYDRATABLE_CATEGORIES),
  );
}

/** Same predicate as the batch selection query — mirrors countPendingForScope. */
export async function countPendingHydration(userId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messageMetadata)
    .where(hydratablePredicate(userId, since));
  return Number(row?.count ?? 0);
}

async function selectHydrationBatch(
  userId: string,
  since: Date,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ entityId: messageMetadata.entityId })
    .from(messageMetadata)
    .where(hydratablePredicate(userId, since))
    .orderBy(sql`${messageMetadata.receivedAt} DESC`)
    .limit(limit);
  return rows.map((r) => r.entityId);
}

/** Claims a batch before fetching — HYDRATING is what lets a crashed worker's
 *  rows be told apart from ones nothing has picked up yet (see hydrationStatus
 *  comment on message-metadata.ts). Attempts are bumped here, at claim time,
 *  not on failure — mirroring classification.ts's incrementAttempts, so a run
 *  that crashes mid-batch still counts as an attempt against the cap. */
async function claimBatch(entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;
  await db
    .update(messageMetadata)
    .set({
      hydrationStatus: "HYDRATING",
      hydrationAttempts: sql`${messageMetadata.hydrationAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(inArray(messageMetadata.entityId, entityIds));
}

/** Rows whose fetch threw a transient error (not a confirmed Gmail 404/410 —
 *  those are marked FAILED by ingestMessage itself). Back to PENDING for a
 *  later batch, unless this claim's attempt just exhausted the cap. */
async function markTransientFailures(entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;
  await db
    .update(messageMetadata)
    .set({
      hydrationStatus: sql`CASE WHEN ${messageMetadata.hydrationAttempts} >= ${MAX_HYDRATION_ATTEMPTS} THEN 'FAILED' ELSE 'PENDING' END`,
      updatedAt: new Date(),
    })
    .where(inArray(messageMetadata.entityId, entityIds));
}

export interface HydrationBatchOutcome {
  attempted: number;
  /** Only ids that actually got a body stored — never the claimed set. The
   *  caller (hydrate-batch Inngest function) must pass only these on to
   *  indexing, so a Gmail failure never leaves indexing chasing an absent
   *  body. */
  hydratedEntityIds: string[];
  remaining: number;
}

/**
 * Runs exactly one batch: claim up to HYDRATION_BATCH_SIZE PENDING rows,
 * fetch+store each body via the existing ingestMessage (with
 * triggerClassification=false, triggerEmbeddings=false — critical, see the
 * plan/comment on the hydrate-batch Inngest function), and report which ids
 * actually hydrated plus how many remain for this window.
 *
 * Deliberately independent of classification.ts's batch loop — different
 * rate-limit domain (Gmail vs LLM), different failure modes, own
 * continuation. See classification-batch.ts / hydrate-batch.ts for why.
 */
export async function runHydrationBatch(
  userId: string,
  since: Date,
  correlationId?: string,
): Promise<HydrationBatchOutcome> {
  const entityIds = await selectHydrationBatch(userId, since, HYDRATION_BATCH_SIZE);
  if (entityIds.length === 0) {
    return { attempted: 0, hydratedEntityIds: [], remaining: 0 };
  }

  await claimBatch(entityIds);

  const hydratedEntityIds: string[] = [];
  const transientFailures: string[] = [];

  let cursor = 0;
  async function worker() {
    while (cursor < entityIds.length) {
      const entityId = entityIds[cursor++]!;
      try {
        const result = await ingestMessage(
          userId,
          entityId,
          false, // triggerEmbeddings — indexing is a separate, explicit stage
          false, // triggerClassification — this batch never re-classifies
          "hydrate",
          correlationId,
        );
        if (result.hydrated) hydratedEntityIds.push(entityId);
        // If not hydrated, ingestMessage already marked the row FAILED itself
        // (confirmed Gmail 404/410) — nothing more to do here.
      } catch (err) {
        // A real failure (auth, transport, quota) — transient by nature.
        // Leave it for markTransientFailures to route back to PENDING or FAILED.
        transientFailures.push(entityId);
        logger.error("[HYDRATE] ingestMessage failed, will retry or cap", {
          userId, entityId, error: String(err),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(HYDRATION_CONCURRENCY, entityIds.length) }, () => worker()),
  );

  await markTransientFailures(transientFailures);

  const remaining = await countPendingHydration(userId, since);

  logger.info("[HYDRATE] batch completed", {
    userId, attempted: entityIds.length, hydrated: hydratedEntityIds.length, remaining,
  });

  return { attempted: entityIds.length, hydratedEntityIds, remaining };
}
