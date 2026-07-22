import type { ToolExecutor } from "@repo/ai";
import { summarizeEmail } from "@repo/ai";
import { db, eq, and, or, ilike, desc, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { emails } from "@repo/database/models/emails";

export interface SummarizeEmailInput {
  entityId?: string;
  query?: string;
}

export interface SummarizeEmailOutput {
  found: boolean;
  entityId?: string;
  /** Gmail thread id. Combine with the app's own /inbox/{threadId} route to link the user straight to it. */
  threadId?: string;
  subject?: string;
  sender?: string;
  receivedAt?: string;
  /** The full structured digest — the model's working context. */
  summary?: string;
  /** The few-sentence overview, for when a short answer is enough. */
  overview?: string;
  /** Guardrailed but uncompressed body — fallback for details the digest omitted. */
  fullText?: string;
  guardrails?: {
    injectionBlocked: boolean;
    maskedCategories: string[];
    secretsRedacted: boolean;
  };
  message?: string;
}

/**
 * Production executor for summarizeEmail — the assistant's route to the same
 * guardrailed notes the inbox card produces.
 *
 * Two properties matter here beyond "it returns a summary":
 *
 * 1. Everything it returns has already been through PII masking, secret
 *    redaction and prompt-injection stripping inside summarizeEmail. That is
 *    load-bearing for the chat case specifically: the tool result is appended
 *    to the conversation, so it stays in context for every following turn.
 *    An unscrubbed body would leak into all of them, not just one answer.
 *
 * 2. It reuses the stored summary when one exists, so asking Dobbie about an
 *    email already summarized in the inbox costs nothing and returns exactly
 *    the same text the user saw there — no contradictory second version.
 */
export class CorsairSummarizeEmailExecutor
  implements ToolExecutor<SummarizeEmailInput, SummarizeEmailOutput>
{
  async execute(
    args: SummarizeEmailInput,
    ctx: { userId: string; requestId: string },
  ): Promise<SummarizeEmailOutput> {
    const { userId } = ctx;
    console.log("[executor:summarizeEmail] START", {
      userId,
      entityId: args.entityId,
      query: args.query,
    });

    try {
      // Ownership is enforced by the user_id predicate in every branch — an
      // id belonging to another mailbox must not be summarizable.
      const base = eq(messageMetadata.userId, userId);

      const where = args.entityId
        ? and(base, eq(messageMetadata.entityId, args.entityId))
        : and(
            base,
            or(
              ilike(messageMetadata.subject, `%${args.query ?? ""}%`),
              ilike(messageMetadata.sender, `%${args.query ?? ""}%`),
            ),
          );

      const [meta] = await db
        .select({
          entityId: messageMetadata.entityId,
          threadId: messageMetadata.threadId,
          sender: messageMetadata.sender,
          subject: messageMetadata.subject,
          snippet: messageMetadata.snippet,
          receivedAt: messageMetadata.receivedAt,
          summary: messageMetadata.summary,
          summaryDigest: messageMetadata.summaryDigest,
          summaryFullText: messageMetadata.summaryFullText,
          summaryFlags: messageMetadata.summaryFlags,
        })
        .from(messageMetadata)
        .where(where)
        .orderBy(desc(messageMetadata.receivedAt))
        .limit(1);

      if (!meta) {
        return {
          found: false,
          message: args.entityId
            ? "No email with that id in this mailbox."
            : `No email found matching "${args.query}". Try searchEmails first to locate it.`,
        };
      }

      const common = {
        found: true,
        entityId: meta.entityId,
        threadId: meta.threadId ?? undefined,
        subject: meta.subject ?? undefined,
        sender: meta.sender ?? undefined,
        receivedAt: meta.receivedAt?.toISOString(),
      };

      if (meta.summary) {
        console.log("[executor:summarizeEmail] cache hit", { entityId: meta.entityId });
        return {
          ...common,
          // The digest is the retrieval context, not the card's overview:
          // it carries every fact, minus ads and boilerplate, at a fraction
          // of the raw email's size — a far better basis for follow-ups.
          summary: meta.summaryDigest || meta.summary,
          overview: meta.summary,
          fullText: meta.summaryFullText ?? undefined,
          guardrails: meta.summaryFlags ?? undefined,
        };
      }

      const [emailRow] = await db
        .select({ bodyText: emails.bodyText })
        .from(emails)
        .where(and(eq(emails.gmailMessageId, meta.entityId), eq(emails.userId, userId)))
        .limit(1);

      const sourceText = emailRow?.bodyText || meta.snippet || "";
      if (!sourceText.trim()) {
        return { ...common, found: true, message: "That email has no readable content to summarize." };
      }

      const result = await summarizeEmail({
        sender: meta.sender || "Unknown Sender",
        subject: meta.subject || "No Subject",
        body: sourceText,
      });

      const guardrails = {
        injectionBlocked: result.injectionBlocked,
        maskedCategories: result.maskedCategories as string[],
        secretsRedacted: result.secretsRedacted,
      };

      // Cached so the inbox card shows the same notes rather than charging
      // the user again for work already done here.
      await db
        .update(messageMetadata)
        .set({
          summary: result.summary,
          summaryDigest: result.digest,
          summaryFullText: result.fullText,
          summaryFlags: guardrails,
          summaryMeta: result.analysis,
          summaryGeneratedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(messageMetadata.entityId, meta.entityId), eq(messageMetadata.userId, userId)),
        );

      console.log("[executor:summarizeEmail] generated", {
        entityId: meta.entityId,
        chars: result.summary.length,
      });

      return {
        ...common,
        summary: result.digest,
        overview: result.summary,
        fullText: result.fullText,
        guardrails,
      };
    } catch (err) {
      console.error("[executor:summarizeEmail] FAILED", err);
      return { found: false, message: "Failed to summarize that email." };
    }
  }
}
