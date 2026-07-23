import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError } from "@repo/ai";
import {
  searchLocalEmails,
  sendEmail as corsairSendEmail,
  replyToEmail as corsairReplyToEmail,
  forwardEmail as corsairForwardEmail,
  previewReply,
  previewForward,
} from "@repo/services/gmail/index";
import { db, eq } from "@repo/database";
import { user } from "@repo/database/schema";

// Ceiling for the summary path (~40 primary); normal fetches are already
// capped to 10 primary inside searchLocalEmails.
const MAX_EMAIL_RESULTS = 40;

async function getAuthenticatedEmail(userId: string): Promise<string> {
  const [dbUser] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!dbUser) {
    throw new Error(`User ${userId} not found`);
  }
  return dbUser.email;
}

export interface SearchEmailsInput {
  query?: string;
  sender?: string;
  withinDays?: number;
  includePromotions?: boolean;
}

export interface SearchEmailsResultItem {
  entityId?: string;
  threadId: string;
  sender: string;
  subject: string;
  date: string;
  snippet: string;
  score?: number;
}

export interface SearchEmailsOutput {
  emails: SearchEmailsResultItem[];
  /** Total primary matches before the display cap (so the model can say "showing 10 of N"). */
  primaryTotal: number;
  /** PROMOTIONS/SPAM/TRASH hidden from `emails` — disclose this to the user. */
  spamCount: number;
  /** Emails withheld because their sender/content is on the user's protected blocklist. */
  hiddenProtected?: { count: number; senders: string[] };
}

/**
 * Production executor for searchEmails.
 *
 * Delegates to @repo/services/gmail → searchLocalEmails(), which searches
 * this mailbox's own synced content — vector search over embeddings first,
 * falling back to an ILIKE scan only if that errors or finds nothing. This
 * reads local Postgres, not the live Gmail API: no network round trip per
 * search, and results carry a local entityId the model can hand straight to
 * summarizeEmail, which the Gmail-API path never had.
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
    console.log("[executor:searchEmails] START", { userId: ctx.userId, query: args.query, sender: args.sender });
    if (!args.query?.trim() && !args.sender?.trim()) {
      throw new ToolExecutionError("searchEmails", new Error("At least one of query or sender is required"));
    }
    try {
      const result = await searchLocalEmails(ctx.userId, {
        query: args.query,
        sender: args.sender,
        withinDays: args.withinDays,
        includePromotions: args.includePromotions,
        applyAssistantRules: true,
      });

      console.log("[executor:searchEmails] RAW RESULT", {
        threadCount: result.threads.length,
        total: result.total,
        spamCount: result.spamCount,
        hiddenProtected: result.hiddenProtected?.count ?? 0,
        firstThread: result.threads[0] ?? null,
      });

      // The service already caps the primary bucket; MAX_EMAIL_RESULTS is a
      // belt-and-suspenders ceiling for the summary path (~40).
      const emails = result.threads.slice(0, MAX_EMAIL_RESULTS).map((t) => ({
        entityId: t.entityId,
        threadId: t.threadId,
        sender: t.sender,
        subject: t.subject,
        date: t.date,
        snippet: t.snippet,
        score: t.score,
      }));

      console.log("[executor:searchEmails] RETURNING", { emailCount: emails.length });
      return {
        emails,
        primaryTotal: result.total,
        spamCount: result.spamCount ?? 0,
        hiddenProtected: result.hiddenProtected,
      };
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
  from?: string;
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
    console.log("[executor:sendEmail] START", { userId: ctx.userId, to: args.to, subject: args.subject, from: args.from });
    try {
      if (args.from) {
        const authenticatedEmail = await getAuthenticatedEmail(ctx.userId);
        if (args.from.toLowerCase() !== authenticatedEmail.toLowerCase()) {
          throw new Error(
            `Cannot send email from ${args.from}. Authenticated account is ${authenticatedEmail}.`
          );
        }
      }

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

// ── replyToEmail ─────────────────────────────────────────────────────

export interface ReplyToEmailInput {
  entityId: string;
  body: string;
  replyAll?: boolean;
}

export interface ReplyToEmailOutput {
  draft: boolean;
  id?: string;
  threadId?: string;
  message?: string;
}

/**
 * Production executor for replyToEmail. Recipient and threading headers are
 * resolved entirely by @repo/services/gmail → replyToEmail() from the
 * original message — this executor supplies only the model's body text.
 */
export class ReplyToEmailExecutor
  implements ToolExecutor<ReplyToEmailInput, ReplyToEmailOutput>
{
  async execute(
    args: ReplyToEmailInput,
    ctx: { userId: string; requestId: string },
  ): Promise<ReplyToEmailOutput> {
    console.log("[executor:replyToEmail] START", { userId: ctx.userId, entityId: args.entityId, replyAll: args.replyAll });
    try {
      const result = await corsairReplyToEmail(ctx.userId, {
        entityId: args.entityId,
        body: args.body,
        replyAll: args.replyAll,
      });
      console.log("[executor:replyToEmail] SUCCESS", { id: result.id, threadId: result.threadId });
      return { draft: false, id: result.id, threadId: result.threadId };
    } catch (error) {
      console.error("[executor:replyToEmail] ERROR", { error: String(error), userId: ctx.userId });
      throw new ToolExecutionError("replyToEmail", error);
    }
  }
}

/**
 * Approval-preview builder for replyToEmail — registered as the tool
 * definition's `buildPreview` (see packages/ai/src/tools/types.ts) so the
 * approval card shows the REAL resolved recipient/subject, not just the
 * model's raw args (which don't contain a recipient at all for this tool).
 */
export async function buildReplyPreview(
  args: Record<string, unknown>,
  ctx: { userId: string; userTimeZone?: string; userEmail?: string },
): Promise<string> {
  const entityId = args.entityId as string | undefined;
  if (!entityId) return "Reply to an email";
  try {
    const target = await previewReply(ctx.userId, entityId, Boolean(args.replyAll));
    const lines = [`To: ${target.to}`];
    if (target.cc) lines.push(`Cc: ${target.cc}`);
    lines.push(`Subject: ${target.subject}`);
    return lines.join("\n");
  } catch (error) {
    console.error("[executor:replyToEmail] preview failed", { error: String(error) });
    return "Reply to an email (could not resolve recipient — check the email still exists)";
  }
}

// ── forwardEmail ─────────────────────────────────────────────────────

export interface ForwardEmailInput {
  entityId: string;
  to: string;
  note?: string;
}

export interface ForwardEmailOutput {
  draft: boolean;
  id?: string;
  threadId?: string;
  message?: string;
}

/**
 * Production executor for forwardEmail. The quoted original is assembled
 * entirely by @repo/services/gmail → forwardEmail() from the message
 * fetched fresh from Gmail — this executor supplies only the recipient and
 * optional note, never the forwarded content itself.
 */
export class ForwardEmailExecutor
  implements ToolExecutor<ForwardEmailInput, ForwardEmailOutput>
{
  async execute(
    args: ForwardEmailInput,
    ctx: { userId: string; requestId: string },
  ): Promise<ForwardEmailOutput> {
    console.log("[executor:forwardEmail] START", { userId: ctx.userId, entityId: args.entityId, to: args.to });
    try {
      const result = await corsairForwardEmail(ctx.userId, {
        entityId: args.entityId,
        to: args.to,
        note: args.note,
      });
      console.log("[executor:forwardEmail] SUCCESS", { id: result.id, threadId: result.threadId });
      return { draft: false, id: result.id, threadId: result.threadId };
    } catch (error) {
      console.error("[executor:forwardEmail] ERROR", { error: String(error), userId: ctx.userId });
      throw new ToolExecutionError("forwardEmail", error);
    }
  }
}

/**
 * Approval-preview builder for forwardEmail — surfaces the resolved subject
 * and warns explicitly when the original has attachments, since
 * buildRawEmail is text/plain only and never carries them over.
 */
export async function buildForwardPreview(
  args: Record<string, unknown>,
  ctx: { userId: string; userTimeZone?: string; userEmail?: string },
): Promise<string> {
  const entityId = args.entityId as string | undefined;
  const to = (args.to as string | undefined) ?? "unknown";
  if (!entityId) return `Forward an email to ${to}`;
  try {
    const target = await previewForward(ctx.userId, entityId);
    const lines = [`To: ${to}`, `Subject: ${target.subject}`];
    if (target.attachmentCount > 0) {
      lines.push(`⚠ ${target.attachmentCount} attachment${target.attachmentCount === 1 ? "" : "s"} will NOT be included`);
    }
    return lines.join("\n");
  } catch (error) {
    console.error("[executor:forwardEmail] preview failed", { error: String(error) });
    return `Forward an email to ${to} (could not resolve subject — check the email still exists)`;
  }
}

