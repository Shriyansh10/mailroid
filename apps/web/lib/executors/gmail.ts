import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError } from "@repo/ai";
import { searchEmails as corsairSearchEmails } from "@repo/services/gmail/index";

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
    try {
      const result = await corsairSearchEmails(ctx.userId, args.query, {
        maxResults: MAX_EMAIL_RESULTS,
      });

      const emails = result.threads.slice(0, MAX_EMAIL_RESULTS).map((t) => ({
        threadId: t.threadId,
        sender: t.sender,
        subject: t.subject,
        date: t.date,
        snippet: t.snippet,
      }));

      return { emails };
    } catch (error) {
      throw new ToolExecutionError("searchEmails", error);
    }
  }
}
