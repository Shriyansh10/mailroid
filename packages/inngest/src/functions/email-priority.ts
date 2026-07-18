import { inngest } from "../client.ts";
import { RetryAfterError, NonRetriableError } from "inngest";
import { db, eq } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { classifyEmailPriority } from "@repo/ai";

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
) {
  try {
    return await classifyEmailPriority(sender, subject, snippet);
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
    // using, which is what made the sync starve on its own load. Sync no
    // longer triggers this (see docs/architecture-plan.md Stage 0), so today
    // this only fires from the webhook's one-email-at-a-time path, but the
    // limit stays as a hard ceiling against any future fan-out.
    concurrency: { limit: Number(process.env.WEBHOOK_CONCURRENCY ?? 2) },
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

    // 2. Classify via LLM — throws on failure (rate limit, malformed output,
    // network error) so Inngest actually retries instead of silently skipping.
    const classification = await step.run("classify-email", () =>
      classifyWithRetryTranslation(
        sender || "Unknown Sender",
        subject || "No Subject",
        snippet || "No Content"
      ),
    );

    // 3. Update database
    await step.run("update-metadata", async () => {
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
    });

    return { success: true, classification };
  }
);
