import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError } from "@repo/ai";
import { searchEmails as corsairSearchEmails, sendEmail as corsairSendEmail } from "@repo/services/gmail/index";

const MAX_EMAIL_RESULTS = 20;

export interface SearchEmailsInput {
  query: string;
}

export interface SearchEmailsOutput {
  emails: Array<Record<string, unknown>>;
}

/**
 * Production executor for searchEmails.
 *
 * Delegates to the existing @repo/services/gmail → searchEmails() which
 * uses Corsair to query Gmail with Gmail search syntax.
 *
 * Normalizes ThreadSummary[] → output schema shape.
 * Hard limit: MAX_EMAIL_RESULTS = 20.
 */
export class CorsairSearchEmailsExecutor
  implements ToolExecutor<SearchEmailsInput, SearchEmailsOutput>
{
  async execute(
    args: SearchEmailsInput,
    ctx: { userId: string; requestId: string },
  ): Promise<SearchEmailsOutput> {
    console.log("[executor:searchEmails] START", { userId: ctx.userId, query: args.query });
    try {
      const result = await corsairSearchEmails(ctx.userId, args.query, {
        maxResults: MAX_EMAIL_RESULTS,
      });

      console.log("[executor:searchEmails] RAW RESULT", {
        threadCount: result.threads.length,
        nextPageToken: result.nextPageToken,
        firstThread: result.threads[0] ?? null,
      });

      const emails = result.threads.slice(0, MAX_EMAIL_RESULTS).map((t) => ({
        threadId: t.threadId,
        sender: t.sender,
        subject: t.subject,
        date: t.date,
        snippet: t.snippet,
      }));

      console.log("[executor:searchEmails] RETURNING", { emailCount: emails.length });
      return { emails };
    } catch (error) {
      console.error("[executor:searchEmails] ERROR", { error: String(error), userId: ctx.userId });
      throw new ToolExecutionError("searchEmails", error);
    }
  }
}

// ── sendEmail ────────────────────────────────────────────────────────

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
}

export interface SendEmailOutput {
  draft: boolean;
  id?: string;
}

/**
 * Production executor for sendEmail.
 *
 * Delegates to @repo/services/gmail → sendEmail() which constructs
 * an RFC 2822 message and calls Corsair's messages.send().
 *
 * Returns the Gmail message/thread IDs on success.
 */
export class CorsairSendEmailExecutor
  implements ToolExecutor<SendEmailInput, SendEmailOutput>
{
  async execute(
    args: SendEmailInput,
    ctx: { userId: string; requestId: string },
  ): Promise<SendEmailOutput> {
    console.log("[executor:sendEmail] START", { userId: ctx.userId, to: args.to, subject: args.subject });
    try {
      const result = await corsairSendEmail(ctx.userId, {
        to: args.to,
        subject: args.subject,
        body: args.body,
      });

      console.log("[executor:sendEmail] SUCCESS", { id: result.id, threadId: result.threadId });
      return { draft: false, id: result.id };
    } catch (error) {
      console.error("[executor:sendEmail] ERROR", { error: String(error), userId: ctx.userId });
      throw new ToolExecutionError("sendEmail", error);
    }
  }
}

