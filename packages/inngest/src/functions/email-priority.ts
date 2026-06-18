import { inngest } from "../client.ts";
import { db, eq } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { classifyEmailPriority } from "@repo/ai";

export const emailPriority = inngest.createFunction(
  { id: "email-priority" },
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

    // 2. Classify via LLM
    const classification = await step.run("classify-email", async () => {
      return await classifyEmailPriority(
        sender || "Unknown Sender",
        subject || "No Subject",
        snippet || "No Content"
      );
    });

    if (!classification) {
      return { success: false, reason: "Classification failed" };
    }

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
          lastClassifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(messageMetadata.entityId, entityId));
    });

    return { success: true, classification };
  }
);
