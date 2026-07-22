import { inngest } from "../client.ts";
import { RetryAfterError, NonRetriableError } from "inngest";
import { db, eq } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { userPriorityProfile } from "@repo/database/models/user-priority-profile";
import {
  classifyEmailPriority,
  buildClassificationContext,
  applyProfileOverrides,
  type ClassificationContext,
} from "@repo/ai";
import { priorityProfileModel } from "@repo/shared";

// The profile read is inlined here (not via @repo/services/profile) because
// @repo/services depends on @repo/inngest — importing it back would create a
// package cycle. One direct row read per webhook email is fine.
async function fetchUserProfile(userId: string) {
  const [row] = await db
    .select({ data: userPriorityProfile.data })
    .from(userPriorityProfile)
    .where(eq(userPriorityProfile.userId, userId))
    .limit(1);
  if (!row) return null;
  const parsed = priorityProfileModel.safeParse(row.data);
  return parsed.success ? parsed.data : null;
}

/**
 * classifyEmailPriority now throws instead of swallowing errors (see
 * @repo/ai/prompts/priority.ts) — this translates a rate-limit-shaped error
 * into Inngest's RetryAfterError so a 429 backs off for the time the
 * provider actually asked for, instead of Inngest's default immediate retry.
 */
async function classifyWithRetryTranslation(
  sender: string,
  subject: string,
  snippet: string,
  context?: ClassificationContext,
) {
  try {
    return await classifyEmailPriority(sender, subject, snippet, context);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const code = (err as { code?: string })?.code;
    // A 429 means two very different things. "Too fast" clears on its own, so
    // backing off is right. "Out of credit" (insufficient_quota) never clears
    // without a human topping up the account — retrying it just burns requests
    // against a dead quota every retryAfter seconds, indefinitely, which is
    // exactly how an exhausted OpenAI balance turned into a silent retry storm.
    // NonRetriableError surfaces it as a failed run instead of hiding it.
    if (code === "insufficient_quota") {
      throw new NonRetriableError("LLM provider quota exhausted — check billing", { cause: err });
    }
    if (status === 429) {
      const retryAfterHeader = (err as { headers?: { get?: (name: string) => string | null } })
        ?.headers?.get?.("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 30_000;
      throw new RetryAfterError("DeepSeek rate limited", retryAfterMs, { cause: err });
    }
    throw err;
  }
}

export const emailPriority = inngest.createFunction(
  {
    id: "email-priority",
    // Previously unbounded — during initial sync this let thousands of
    // concurrent runs pile into the same API container the sync itself was
    // using, which is what made the sync starve on its own load.
    //
    // Every bulk path now classifies in batches instead of emitting one event
    // per email: sync-metadata.ts stopped emitting, and syncEmails passes
    // triggerClassification=false to ingestMessage. So this should only fire
    // from the webhook, one email at a time. The limit stays as a hard ceiling
    // — the claim above was true of sync-metadata.ts alone once before, while
    // ingestMessage was quietly fanning out thousands of runs from the Sync
    // button.
    concurrency: { limit: Number(process.env.WEBHOOK_CONCURRENCY ?? 2) },
    // One run per message, no matter how many times it is announced. Gmail
    // pushes a separate notification (with its own historyId) for every
    // mailbox mutation, and a failed history diff is retried wholesale, so the
    // same entityId legitimately arrives many times over. Without this key each
    // arrival became its own queued run — 70k of them, against a drain rate of
    // ~2 per 22s, which pinned the container until they were bulk-cancelled.
    // The "already classified" guard below cannot help there: it only runs once
    // a run has started, so it bounds LLM calls, never queue depth.
    idempotency: "event.data.entityId",
  },
  { event: "email.received" },
  async ({ event, step }) => {
    const { userId, entityId } = event.data;

    // 1. Fetch message metadata from DB
    const metadata = await step.run("fetch-metadata", async () => {
      const records = await db
        .select()
        .from(messageMetadata)
        .where(eq(messageMetadata.entityId, entityId));
      return records[0];
    });

    if (!metadata) {
      return { success: false, reason: "Metadata not found" };
    }

    if (metadata.priorityScore !== null && metadata.lastClassifiedAt !== null) {
      return { success: true, reason: "Already classified", metadata };
    }

    const { sender, subject, snippet } = metadata;
    if (!sender && !subject && !snippet) {
      return { success: false, reason: "No content to classify" };
    }

    // 2. Fetch the user's priority profile (null = classify exactly as
    // before personalization existed).
    const profile = await step.run("fetch-profile", () => fetchUserProfile(userId));

    // 3. Classify via LLM — throws on failure (rate limit, malformed output,
    // network error) so Inngest actually retries instead of silently skipping.
    const rawClassification = await step.run("classify-email", () =>
      classifyWithRetryTranslation(
        sender || "Unknown Sender",
        subject || "No Subject",
        snippet || "No Content",
        profile ? buildClassificationContext({ profile }) : undefined,
      ),
    );

    // Muted senders are a hard rule applied in code, whatever the LLM said.
    const classification = applyProfileOverrides(
      sender || "",
      rawClassification,
      profile
        ? {
            mutedDomains: profile.senders.mutedDomains,
            preferences: {
              githubNotifications: profile.preferences.githubNotifications,
            },
          }
        : undefined,
    );

    // 4. Update database
    await step.run("update-metadata", async () => {
      await db
        .update(messageMetadata)
        .set({
          priority: classification.priority,
          priorityScore: classification.priorityScore,
          priorityReason: classification.priorityReason,
          matchedSignals: classification.matchedSignals,
          isActionRequired: classification.isActionRequired,
          isReplyNeeded: classification.isReplyNeeded,
          classificationStatus: "DONE",
          lastClassifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(messageMetadata.entityId, entityId));
    });

    return { success: true, classification };
  }
);
