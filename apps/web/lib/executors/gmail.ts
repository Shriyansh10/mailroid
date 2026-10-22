import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError, appendSignature, shapeSearchEmailsForModel } from "@repo/ai";
import {
  searchLocalEmails,
  sendEmail as corsairSendEmail,
  replyToEmail as corsairReplyToEmail,
  forwardEmail as corsairForwardEmail,
  previewReply,
  previewForward,
} from "@repo/services/gmail/index";
import { getPriorityProfile } from "@repo/services/profile/index";
import { describeForwardPreview } from "@repo/services/gmail/forward-attachments";
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

/**
 * `enrichArgs` for sendEmail/replyToEmail/forwardEmail (see
 * packages/ai/src/tools/types.ts) — appends the user's saved signature to
 * `args.body` BEFORE the approval row is created, so the approval-card
 * preview, the Phase 4 edit textarea, and the mail that actually sends are
 * always the same text. Must run exactly once, here, not in `execute()`:
 * the executor only runs after the user approves, so appending there would
 * show an unsigned body on the card and send a signed one.
 */
export async function enrichMailBodyArgs(
  args: Record<string, unknown>,
  ctx: { userId: string },
): Promise<Record<string, unknown>> {
  if (typeof args.body !== "string") return args;

  const profile = await getPriorityProfile(ctx.userId);
  const signature = profile?.data.signature;
  if (!signature?.enabled || !signature.text.trim()) return args;

  return { ...args, body: appendSignature(args.body, signature) };
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
    console.log("[executor:searchEmails] START", {
      userId: ctx.userId,
      queryLength: args.query?.length ?? 0,
      hasSender: !!args.sender?.trim(),
    });
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

      // Counts only: a success is a statistic. The message name is kept so
      // existing log queries still match.
      console.log("[executor:searchEmails] RAW RESULT", {
        requestId: ctx.requestId,
        threadCount: result.threads.length,
        total: result.total,
        spamCount: result.spamCount,
        hiddenProtected: result.hiddenProtected?.count ?? 0,
      });

      // The service already caps the primary bucket; MAX_EMAIL_RESULTS is a
      // belt-and-suspenders ceiling for the summary path (~40).
      //
      // Masked on the way out: senders become display names, and subject,
      // snippet and protected-sender entries lose addresses and phone numbers.
      // The agent loop's own output pass does not mask those, and the system
      // prompt tells the model they already were. The sender FILTER above ran
      // server-side against the real headers, so searching is unaffected.
      const shaped = shapeSearchEmailsForModel(result, MAX_EMAIL_RESULTS);

      console.log("[executor:searchEmails] RETURNING", { emailCount: shaped.emails.length });
      return shaped;
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
  threadId?: string;
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
    console.log("[executor:sendEmail] START", {
      userId: ctx.userId,
      recipientCount: args.to.split(",").filter((s) => s.trim()).length,
      hasFrom: !!args.from,
    });
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
      // threadId travels with the result so a follow-up turn can act on the
      // thread it just created (reply, attach an invite, link a meeting)
      // without a second lookup — replyToEmail has always returned it.
      return { draft: false, id: result.id, threadId: result.threadId };
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
  omitOriginalAttachments?: boolean;
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
    console.log("[executor:forwardEmail] START", {
      userId: ctx.userId,
      entityId: args.entityId,
      recipientCount: args.to.split(",").filter((s) => s.trim()).length,
    });
    try {
      const result = await corsairForwardEmail(ctx.userId, {
        entityId: args.entityId,
        to: args.to,
        note: args.note,
        omitOriginalAttachments: args.omitOriginalAttachments === true,
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
 * and states what will travel with the message.
 *
 * The approval card is the last thing a user reads before real mail leaves,
 * so it NAMES the original's files rather than counting them: "contract.pdf"
 * versus "1 attachment" is the difference between knowingly forwarding a
 * contract and forwarding one by accident. It is also a promise the service
 * keeps — those files go, or nothing does (forward-attachments.ts) — and when
 * the user chose to forward without them, the card says that instead.
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
    return describeForwardPreview({
      to,
      subject: target.subject,
      attachmentNames: target.attachmentNames,
      omitOriginalAttachments: args.omitOriginalAttachments === true,
    });
  } catch (error) {
    console.error("[executor:forwardEmail] preview failed", { error: String(error) });
    return `Forward an email to ${to} (could not resolve subject — check the email still exists)`;
  }
}

