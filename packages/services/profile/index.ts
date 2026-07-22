import { db, eq } from "@repo/database";
import { userPriorityProfile } from "@repo/database/models/user-priority-profile";
import {
  priorityProfileModel,
  normalizePriorityProfile,
  type PriorityProfile,
  type PriorityProfileRecord,
} from "@repo/shared";
import {
  buildClassificationContext,
  type ClassificationContext,
} from "@repo/ai";
import { logger } from "@repo/logger";

// ── Read ──────────────────────────────────────────────────────────────

export async function getPriorityProfile(
  userId: string,
): Promise<PriorityProfileRecord | null> {
  const [row] = await db
    .select()
    .from(userPriorityProfile)
    .where(eq(userPriorityProfile.userId, userId))
    .limit(1);
  if (!row) return null;

  const parsed = priorityProfileModel.safeParse(row.data);
  if (!parsed.success) {
    // A row that fails its own schema (e.g. written by a future version and
    // rolled back) is treated as absent rather than crashing every read.
    logger.error("[PROFILE] stored profile failed schema parse", {
      userId,
      error: parsed.error.message,
    });
    return null;
  }

  return {
    data: parsed.data,
    completedOnboarding: row.completedOnboarding,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

// ── Write ─────────────────────────────────────────────────────────────

const FOCUS_TTL_DAYS = 30;

/**
 * The single write path. Sanitizes (normalize) then re-validates (parse)
 * regardless of what the transport already checked — the "zod checked
 * before feeding the DB" guarantee holds even for future callers that
 * bypass tRPC.
 *
 * currentFocus.expiresAt is stamped here (now + 30 days) whenever the focus
 * items changed, so "preparing for exams" stops influencing classification
 * a month later without the user doing anything.
 */
export async function upsertPriorityProfile(
  userId: string,
  input: PriorityProfile,
  options: { completedOnboarding: boolean },
): Promise<void> {
  const normalized = normalizePriorityProfile(input);

  const existing = await getPriorityProfile(userId);
  const prevItems = existing?.data.interests.currentFocus.items ?? [];
  const nextItems = normalized.interests.currentFocus.items;
  const focusChanged =
    prevItems.length !== nextItems.length ||
    nextItems.some((item, i) => item !== prevItems[i]);
  if (focusChanged) {
    normalized.interests.currentFocus.expiresAt =
      nextItems.length > 0
        ? new Date(Date.now() + FOCUS_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
        : null;
  } else if (existing) {
    normalized.interests.currentFocus.expiresAt =
      existing.data.interests.currentFocus.expiresAt;
  }

  const data = priorityProfileModel.parse(normalized);

  await db
    .insert(userPriorityProfile)
    .values({
      userId,
      data,
      completedOnboarding: options.completedOnboarding,
    })
    .onConflictDoUpdate({
      target: userPriorityProfile.userId,
      set: {
        data,
        // Skipping after having filled must not downgrade the flag.
        completedOnboarding: options.completedOnboarding
          ? true
          : (existing?.completedOnboarding ?? false),
        updatedAt: new Date(),
      },
    });

  contextCache.delete(userId);
  logger.info("[PROFILE] priority profile upserted", {
    userId,
    completedOnboarding: options.completedOnboarding,
  });
}

// ── Classification context (cached) ───────────────────────────────────

export interface UserClassificationContext {
  context: ClassificationContext;
  mutedDomains: string[];
  preferences: { githubNotifications: boolean };
}

// The summary is derived, never stored: DB -> JSON profile -> summary
// builder -> this cache -> LLM. 60s TTL means a 500-email batch does one DB
// read and one template render, while profile edits reach classification
// within a minute even if the upsert happened in another process.
const CONTEXT_TTL_MS = 60_000;
const contextCache = new Map<
  string,
  { value: UserClassificationContext | null; expiresAt: number }
>();

export async function getClassificationContext(
  userId: string,
): Promise<UserClassificationContext | null> {
  const cached = contextCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const record = await getPriorityProfile(userId);
  const value: UserClassificationContext | null = record
    ? {
        context: buildClassificationContext({ profile: record.data }),
        mutedDomains: record.data.senders.mutedDomains,
        preferences: {
          githubNotifications: record.data.preferences.githubNotifications,
        },
      }
    : null;

  contextCache.set(userId, { value, expiresAt: Date.now() + CONTEXT_TTL_MS });
  return value;
}
