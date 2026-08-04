import { ToolExecutionStatus, type ToolResult } from "@repo/ai";

/**
 * Active-email ledger entry, written onto a tool message's `metadata` column
 * when summarizeEmail resolves an email successfully. The active email for a
 * conversation is simply "the newest assistant_messages row whose metadata
 * contains emailRef" — no separate table, no migration, and it naturally
 * follows the user switching emails mid-chat (newest write wins).
 */
export interface EmailRef {
  entityId: string;
  threadId?: string;
  subject?: string;
  sender?: string;
  receivedAt?: string;
}

/**
 * Record of an outward-facing write the agent actually completed — a mail
 * that left the account, an event that now sits on a calendar.
 *
 * Deliberately a DIFFERENT metadata key from `emailRef`. `emailRef` means
 * "an email in this user's synced mailbox", and `getActiveEmailContext`
 * resolves it by re-reading `message_metadata` by entityId. A message this
 * agent just sent has no such row, so filing it as an emailRef would make
 * the newest ref fail to resolve and silently blank the conversation's
 * active email — the exact silent degradation CLAUDE.md forbids.
 */
export interface ActionRef {
  kind:
    | "email-sent"
    | "email-replied"
    | "email-forwarded"
    | "event-created"
    | "meeting-scheduled"
    | "meeting-moved"
    | "meeting-cancelled";
  /** Gmail thread the message landed in, when the tool reports one. */
  threadId?: string;
  /** Gmail message id, or the calendar event id for event-created. */
  id?: string;
  to?: string;
  subject?: string;
}

/**
 * Tools whose success is an irreversible, outward-facing action.
 *
 * The thread-meeting tools belong here for exactly the reason the ledger
 * exists: an invite that has gone out is as unrecallable as a sent mail, and
 * omitting them meant a resumed loop had no record that the meeting was
 * already booked — so it re-issued the call and asked the user to approve a
 * duplicate.
 */
const ACTION_KINDS: Record<string, ActionRef["kind"]> = {
  sendEmail: "email-sent",
  replyToEmail: "email-replied",
  forwardEmail: "email-forwarded",
  createEvent: "event-created",
  scheduleThreadMeeting: "meeting-scheduled",
  rescheduleThreadMeeting: "meeting-moved",
  cancelThreadMeeting: "meeting-cancelled",
};


/**
 * The meeting times most recently offered to the user.
 *
 * Stored so "earlier" can re-rank the set already on screen instead of
 * re-running the search. A fresh search would return a different set, and
 * answering "can we do earlier?" with unrelated times reads as the assistant
 * ignoring the question.
 */
export interface SlotProposalRef {
  intent: string;
  durationMinutes: number;
  candidates: {
    start: string;
    end: string;
    score: number;
    reasons: { code: string; text: string; ruleId?: string }[];
  }[];
}

/**
 * The thread meetings most recently listed to the user, and the token +
 * start time each was shown with.
 *
 * This is the drift-detection half of the `selectionId` scheme in
 * `packages/services/calendar/thread-links.ts`. `selectionId` is a stable
 * hash of the event id — deliberately not looked up in a stored mapping, so
 * it survives history trimming and needs no cleanup — but a pure hash alone
 * only catches CANCELLATION drift (the token stops matching anything). If the
 * SAME meeting is moved to a different time by someone else between being
 * listed and being acted on, the hash still resolves to it, silently, even
 * though what the model told the user no longer matches reality.
 *
 * This ledger is what closes that gap: `getThreadMeetings`'s result is
 * recorded here, and `rescheduleThreadMeeting`/`cancelThreadMeeting` have the
 * matching entry's `start` injected into their args server-side (mirroring
 * how `refineMeetingSlots` gets `previousCandidates` injected — see
 * `apps/web/app/api/chat/route.ts`), so the resolver in `thread-links.ts` can
 * compare "what was shown" against "what's true now" and refuse on a
 * mismatch instead of silently acting on a meeting that moved.
 *
 * Best-effort, not a hard requirement: if no ledger entry exists (the
 * precheck's own refusal lists meetings without a prior `getThreadMeetings`
 * call, since the precheck has no conversationId to write one from), there is
 * nothing to compare against and the resolver skips the check rather than
 * blocking on missing data it was never given.
 */
export interface MeetingSelectionRef {
  threadId: string;
  meetings: { selectionId: string; start: string; title: string }[];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Derives the metadata to persist alongside a tool result, keyed by tool
 * name. Kept in apps/web (not @repo/ai) because it knows about these specific
 * tools' output shapes — @repo/ai's agent loop stays tool-agnostic and just
 * calls this as an injected hook.
 *
 * Two independent ledgers:
 *   - `emailRef` (summarizeEmail) — which email is under discussion.
 *   - `actionRef` (sendEmail / replyToEmail / forwardEmail / createEvent) —
 *     what has already been done. This is what lets a resumed loop see that
 *     the mail went out rather than inferring it from prose and sending a
 *     second one.
 *
 * Deliberately does NOT write emailRef when the lookup failed (found:false)
 * — a failed lookup must not clear the conversation's active email. Likewise
 * an actionRef is only written on SUCCESS: a failed or merely approval-
 * pending send has not happened yet and must never read as done.
 */
export function deriveToolMessageMetadata(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
): Record<string, unknown> | undefined {
  if (result.status !== ToolExecutionStatus.SUCCESS) return undefined;

  const actionKind = ACTION_KINDS[toolName];
  if (actionKind) {
    const data = result.data as
      | { id?: string; threadId?: string; draft?: boolean; cancelled?: boolean }
      | undefined;

    // A draft was prepared, not sent — not an outward-facing action.
    if (data?.draft) return undefined;

    // cancelThreadMeeting reports {cancelled} rather than {draft,id}, so the
    // draft guard above passes vacuously for it. A false here means nothing
    // was called off, and recording it as done would be a lie the model then
    // repeats to the user.
    if (actionKind === "meeting-cancelled" && data?.cancelled !== true) {
      return undefined;
    }

    const actionRef: ActionRef = {
      kind: actionKind,
      // The thread-meeting tools return only {draft,id}, so without the args
      // fallback their ref would carry no thread and be useless for telling a
      // resumed loop *which* thread was already handled.
      threadId: asString(data?.threadId) ?? asString(args.threadId),
      id: asString(data?.id),
      to: asString(args.to),
      subject: asString(args.subject) ?? asString(args.title),
    };

    return { actionRef, toolName };
  }

  // Slot proposals: remember what was offered, so a follow-up adjustment
  // re-ranks the same options rather than searching again.
  if (toolName === "findMeetingSlots" || toolName === "refineMeetingSlots") {
    const data = result.data as
      | { intent?: string; durationMinutes?: number; candidates?: SlotProposalRef["candidates"] }
      | undefined;

    // An empty result must not overwrite a good proposal — "earlier" after a
    // failed refine should still see the times the user was actually shown.
    if (!data?.candidates?.length) return undefined;

    const slotProposal: SlotProposalRef = {
      intent: data.intent ?? "GENERAL_MEETING",
      durationMinutes: data.durationMinutes ?? 0,
      candidates: data.candidates,
    };
    return { slotProposal, toolName };
  }

  // Meeting selection: remember what was listed, so reschedule/cancel can
  // detect drift instead of silently acting on a meeting that moved since.
  if (toolName === "getThreadMeetings") {
    const data = result.data as
      | { meetings?: { selectionId?: string; start?: string; title?: string }[] }
      | undefined;
    const threadId = asString(args.threadId);

    if (!threadId || !data?.meetings?.length) return undefined;

    const meetings = data.meetings
      .filter((m): m is { selectionId: string; start: string; title: string } =>
        typeof m.selectionId === "string" && typeof m.start === "string",
      )
      .map((m) => ({ selectionId: m.selectionId, start: m.start, title: m.title ?? "" }));

    if (meetings.length === 0) return undefined;

    const meetingSelection: MeetingSelectionRef = { threadId, meetings };
    return { meetingSelection, toolName };
  }

  if (toolName !== "summarizeEmail") return undefined;

  const data = result.data as
    | { found?: boolean; entityId?: string; threadId?: string; subject?: string; sender?: string; receivedAt?: string }
    | undefined;

  if (!data?.found || !data.entityId) return undefined;

  const emailRef: EmailRef = {
    entityId: data.entityId,
    threadId: data.threadId,
    subject: data.subject,
    sender: data.sender,
    receivedAt: data.receivedAt,
  };

  // toolName travels with the ref so history trimming can rebuild a
  // correctly-tagged <tool_result tool="..."> stub without guessing.
  return { emailRef, toolName };
}
