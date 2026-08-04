import {
  recordSchedulingOutcome,
  classifyOutcome,
  findLearnedSuggestion,
  proposeLearnedRule,
} from "@repo/services/scheduling/learning";
import { getLatestSlotProposal } from "./history";
import { parseZonedWallClock } from "@repo/shared/time";

/** Tools whose approval represents a meeting time being committed. */
export const SCHEDULING_TOOLS = new Set([
  "createEvent",
  "scheduleThreadMeeting",
  "rescheduleThreadMeeting",
]);

/**
 * Compare the time the engine proposed with the time the user approved, log
 * the difference, and — after enough consistent corrections — propose a rule.
 *
 * Called fire-and-forget from the approve route. Learning is a side effect of
 * scheduling, never a precondition for it: if any of this fails, the meeting
 * is still booked and the user never hears about it.
 */
export async function recordProposalOutcome(opts: {
  userId: string;
  conversationId: string;
  approvalId: string;
  args: Record<string, unknown>;
  timeZone: string;
}): Promise<void> {
  try {
    const proposal = await getLatestSlotProposal(opts.conversationId);
    // Nothing was proposed by the engine — the user or the model picked a time
    // directly, so there is no correction to measure and nothing to learn.
    if (!proposal?.candidates?.length) return;

    // Both sides go through the same zone-aware parse. They are both
    // offset-less local strings, and resolving either with a bare `new Date()`
    // measured them against the server's zone — which made every accepted
    // suggestion look EDITED by the user's whole UTC offset in a non-UTC zone,
    // and taught the rule engine from a difference that was never real.
    const approvedStart = parseDate(opts.args.start, opts.timeZone);
    const approvedEnd = parseDate(opts.args.end, opts.timeZone);
    if (!approvedStart) return;

    // The top-ranked candidate is what was actually recommended; measuring
    // against any other would score the engine on advice it did not give.
    const top = proposal.candidates[0]!;
    const proposedStart = parseDate(top.start, opts.timeZone);
    const proposedEnd = parseDate(top.end, opts.timeZone);
    if (!proposedStart || !proposedEnd) return;

    const outcome = classifyOutcome(proposedStart, approvedStart);

    await recordSchedulingOutcome({
      userId: opts.userId,
      approvalId: opts.approvalId,
      intent: proposal.intent,
      proposedStart,
      proposedEnd,
      approvedStart,
      approvedEnd: approvedEnd ?? null,
      outcome,
    });

    // Only a genuine correction can teach anything. Accepting the suggestion
    // confirms the current rules; it does not argue for a new one.
    if (outcome !== "EDITED") return;

    const suggestion = await findLearnedSuggestion(
      opts.userId,
      proposal.intent,
      opts.timeZone,
    );
    if (!suggestion) return;

    // Stored INACTIVE. It appears in the memory panel for confirmation and
    // changes nothing until the user accepts it.
    await proposeLearnedRule(opts.userId, suggestion);
  } catch (error) {
    console.warn("[scheduling:outcome:failed]", {
      userId: opts.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseDate(value: unknown, timeZone: string): Date | null {
  if (typeof value !== "string" || !value) return null;
  return parseZonedWallClock(value, timeZone);
}
