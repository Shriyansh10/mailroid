import { db } from "@repo/database";
import { emails } from "@repo/database/models/emails";
import { eq, sql, and } from "@repo/database";
import { createEmbeddingsBatch, withAiUsage } from "@repo/ai";

const BATCH_SIZE = 20;

/**
 * Inngest function: generates embeddings for all emails that don't have one.
 *
 * Trigger: manual or scheduled via Inngest dashboard.
 * Ready to be wired to `email.received` webhook or `gmail.initial-sync` completion.
 *
 * Uses the shared @repo/ai embeddings client (createEmbeddingsBatch) instead
 * of constructing its own — that duplicate client used to mean this path's
 * calls were invisible to usage tracking and untagged with a provider.
 */
export async function emailEmbed({ userId }: { userId: string }) {
  return withAiUsage({ userId }, () => emailEmbedInner(userId));
}

async function emailEmbedInner(userId: string) {
  const unEmbedded = await db
    .select({ id: emails.id, subject: emails.subject, bodyText: emails.bodyText })
    .from(emails)
    .where(and(eq(emails.userId, userId), sql`${emails.embedding} IS NULL`));

  if (unEmbedded.length === 0) return { success: true, embedded: 0 };

  let embedded = 0;

  for (let i = 0; i < unEmbedded.length; i += BATCH_SIZE) {
    const batch = unEmbedded.slice(i, i + BATCH_SIZE);
    const texts = batch.map((e: { subject: string | null; bodyText: string | null }) => (e.subject ?? "") + "\n\n" + (e.bodyText ?? ""));

    const vectors = await createEmbeddingsBatch(texts, { feature: "embed:webhook" });

    for (let j = 0; j < batch.length; j++) {
      await db
        .update(emails)
        .set({ embedding: vectors[j]! })
        .where(eq(emails.id, batch[j]!.id));
    }

    embedded += batch.length;
  }

  return { success: true, embedded };
}
