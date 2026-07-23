import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError } from "@repo/ai";
import { getOrCreateSummary, type EmailCandidate } from "@web/lib/summarize/get-or-create-summary";

export interface SummarizeEmailInput {
  entityId?: string;
  /** Gmail thread id — accepted directly, and also tried as a fallback when entityId misses (the model sometimes confuses the two). */
  threadId?: string;
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
  guardrails?: {
    injectionBlocked: boolean;
    maskedCategories: string[];
    secretsRedacted: boolean;
  };
  message?: string;
  /** True when `query` matched more than one email — `candidates` lists them so the model can ask which one. */
  ambiguous?: boolean;
  candidates?: EmailCandidate[];
}

/**
 * Production executor for summarizeEmail — the assistant's route to the same
 * guardrailed notes the inbox card produces, via the shared getOrCreateSummary
 * pipeline (apps/web/lib/summarize/get-or-create-summary.ts). Two properties
 * matter here beyond "it returns a summary":
 *
 * 1. Everything it returns has already been through PII masking, secret
 *    redaction, prompt-injection stripping and content-link neutralization
 *    inside summarizeEmail. That is load-bearing for the chat case
 *    specifically: the tool result is appended to the conversation, so it
 *    stays in context for every following turn. An unscrubbed body would
 *    leak into all of them, not just one answer.
 *
 * 2. It reuses the stored summary when one exists, so asking Dobbie about an
 *    email already summarized in the inbox costs nothing and returns exactly
 *    the same text the user saw there — no contradictory second version.
 *
 * charge:"never" — the chat route already charges one daily action per turn
 * (apps/web/app/api/chat/route.ts), so charging again here would double-bill
 * a single user request. /api/summarize (the inbox "Summarize this mail"
 * button) is the one caller that charges.
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
      threadId: args.threadId,
      query: args.query,
    });

    const outcome = await getOrCreateSummary({
      userId,
      entityId: args.entityId,
      threadId: args.threadId,
      query: args.query,
      charge: "never",
    });

    if (!outcome.ok) {
      if (outcome.reason === "generation_failed") {
        // A real failure (provider error, empty digest, ...) must surface as
        // a tool error — framed as <tool_error> by the agent loop — not as
        // {found:false}, which reads to the model as "no such email" and
        // silently skips charging the daily-action counter for this turn.
        throw new ToolExecutionError("summarizeEmail", new Error(outcome.message));
      }

      if (outcome.reason === "blocked") {
        // Protected sender/keyword — surface as a clean <tool_error> refusal
        // so the model relays it rather than treating it as "no such email".
        throw new ToolExecutionError("summarizeEmail", new Error(outcome.message));
      }

      if (outcome.reason === "ambiguous") {
        return { found: false, ambiguous: true, candidates: outcome.candidates, message: outcome.message };
      }

      if (outcome.reason === "no_content") {
        // The email itself resolved — it just has nothing worth summarizing
        // (e.g. an image-only message). Identity/threadId still stand.
        return {
          found: true,
          entityId: outcome.entityId,
          threadId: outcome.threadId,
          subject: outcome.subject,
          sender: outcome.sender,
          receivedAt: outcome.receivedAt,
          message: outcome.message,
        };
      }

      return { found: false, message: outcome.message };
    }

    console.log(
      outcome.source === "cache"
        ? "[executor:summarizeEmail] cache hit"
        : "[executor:summarizeEmail] generated",
      { entityId: outcome.entityId },
    );

    return {
      found: true,
      entityId: outcome.entityId,
      threadId: outcome.threadId,
      subject: outcome.subject,
      sender: outcome.sender,
      receivedAt: outcome.receivedAt,
      // The tool's "summary" field is the full digest — the model's working
      // context — while "overview" is the short version. This is the
      // opposite naming from /api/summarize's response shape (summary=short,
      // digest=full); both map from the same canonical SummaryOutcome.
      summary: outcome.digest,
      overview: outcome.summary,
      guardrails: outcome.flags,
    };
  }
}
