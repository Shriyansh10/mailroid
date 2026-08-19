"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  SendIcon,
  SaveIcon,
  Trash2Icon,
  Loader2Icon,
  XIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@web/components/ui/button";
import { Textarea } from "@web/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@web/components/ui/alert-dialog";
import { cn } from "@web/lib/utils";
import {
  useReplyToEmail,
  useForwardEmail,
  useSaveDraft,
  useSendDraft,
  useDiscardDraft,
} from "@web/hooks/api/gmail";
import {
  useCreateEvent,
  useUpdateEvent,
  useThreadMeetings,
  useAcknowledgeThreadMeeting,
} from "@web/hooks/api/calendar";
import { TemplatePicker, type MailTemplate } from "@web/components/inbox/template-picker";
import { AiGeneratePanel } from "@web/components/inbox/ai-generate-panel";
import {
  RecipientFields,
  firstInvalidRecipientField,
  visibleRecipients,
  type RecipientFieldsHandle,
  type RecipientValues,
} from "@web/components/inbox/recipient-fields";
import { parseAddressList } from "@web/lib/email-addresses";
import {
  MeetingInviteFields,
  emptyMeetingState,
  meetingStateFromTemplate,
  meetingStateFromExisting,
  meetingTimesFor,
  buildEventInput,
  type MeetingState,
} from "@web/components/inbox/meeting-invite-fields";

export type InlineReplyMode = "reply" | "replyAll" | "forward";

/**
 * The message being replied to/forwarded. Used ONLY for display (the
 * quoted-text preview and the AI panel's context) — never sent as-is. The
 * subject and the threading headers still come from `replyToEmail`/
 * `forwardEmail` re-fetching this same message server-side, so a wrong or
 * stale object here can at worst produce a wrong-looking preview.
 *
 * Recipients are the one thing no longer derived from it: they're seeded into
 * editable To/Cc/Bcc lines and sent as whatever the user leaves on screen.
 */
export interface QuotedMessage {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

export interface InlineReplyBoxProps {
  mode: InlineReplyMode;
  threadId: string;
  /** The message this reply/forward targets — always the thread's LAST message. */
  entityId: string;
  quoted: QuotedMessage;
  /**
   * Present when this box is resuming an existing draft (only ever true for
   * drafts flagged `isReplyToExisting` — see getDraft) — switches Send/Save/
   * Discard to the draft mutations.
   */
  draftId?: string;
  /** The subject to save the draft under. Never shown/edited inline — Gmail's own inline reply doesn't expose it either. */
  subject: string;
  /**
   * Seeds for the three recipient lines. Every mode gets them editable, so
   * these are a starting point rather than the final recipients: whatever is
   * on screen at send time is what goes out (see handleSend).
   */
  initialTo?: string;
  initialCc?: string;
  initialBcc?: string;
  initialBody?: string;
  onClose: () => void;
  onSent: () => void;
}

function renderQuotedText(q: QuotedMessage, variant: "forward" | "reply"): string {
  if (variant === "forward") {
    return [
      "---------- Forwarded message ---------",
      `From: ${q.from}`,
      `Date: ${q.date}`,
      `Subject: ${q.subject}`,
      `To: ${q.to}`,
      "",
      q.body,
    ].join("\n");
  }
  return [`On ${q.date}, ${q.from} wrote:`, "", q.body].join("\n");
}

/**
 * The "⋯" affordance from Gmail's own reply box: quoted history stays
 * collapsed until clicked, rather than being dumped into the editable body.
 * `alwaysOpen` renders the same content with no toggle, for forward — Gmail
 * shows a forward's quoted content up front rather than hiding it.
 */
function QuotedHistoryToggle({
  quoted,
  variant,
  alwaysOpen,
}: {
  quoted: QuotedMessage;
  variant: "forward" | "reply";
  alwaysOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(alwaysOpen));

  return (
    <div className="mt-1">
      {!alwaysOpen && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={open ? "Hide quoted text" : "Show quoted text"}
          className="size-7 rounded-full border bg-muted/40 hover:bg-muted flex items-center justify-center text-muted-foreground transition-colors"
        >
          <MoreHorizontalIcon className="size-4" />
        </button>
      )}
      {open && (
        <div
          className={cn(
            "text-xs text-muted-foreground whitespace-pre-wrap break-words",
            alwaysOpen
              ? "rounded-lg border bg-muted/20 p-3"
              : "mt-2 pl-3 border-l-2 border-border",
          )}
        >
          {renderQuotedText(quoted, variant)}
        </div>
      )}
    </div>
  );
}

export function InlineReplyBox({
  mode,
  threadId,
  entityId,
  quoted,
  draftId,
  subject,
  initialTo,
  initialCc,
  initialBcc,
  initialBody,
  onClose,
  onSent,
}: InlineReplyBoxProps) {
  const { replyToEmailAsync } = useReplyToEmail();
  const { forwardEmailAsync } = useForwardEmail();
  const { saveDraftAsync } = useSaveDraft();
  const { sendDraftAsync } = useSendDraft();
  const { discardDraftAsync } = useDiscardDraft();
  const { createEventAsync } = useCreateEvent();
  const { updateEventAsync } = useUpdateEvent();
  const { upcomingMeeting, deletedLink } = useThreadMeetings(threadId);
  const { acknowledgeAsync } = useAcknowledgeThreadMeeting();

  const isFreshForward = mode === "forward" && !draftId;

  // All three lines are editable in every mode, Gmail-style — including a
  // plain reply, where the seed is the sender but the user may well want to
  // add someone or move the conversation elsewhere before sending.
  const [recipients, setRecipients] = useState<RecipientValues>({
    to: initialTo ?? "",
    cc: initialCc ?? "",
    bcc: initialBcc ?? "",
  });
  const recipientsRef = useRef<RecipientFieldsHandle>(null);
  const [body, setBody] = useState(initialBody ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [meetingState, setMeetingState] = useState<MeetingState>(emptyMeetingState);
  const [pendingApply, setPendingApply] = useState<null | {
    kind: "body" | "meeting";
    run: () => void;
  }>(null);

  // Seed the meeting fields from the thread's existing meeting, so scheduling
  // again moves it rather than creating a second one. Seeded once per event id:
  // once the user clicks "Create a second meeting instead" (clearing `target`),
  // a refetch must not quietly put them back into move mode.
  const seededEventIdRef = useRef<string | null>(null);
  useEffect(() => {
    // `upcomingMeeting`, not `primaryMeeting`: seeding from a meeting that
    // has already ended puts these fields into update mode against something
    // that cannot be moved, so Send would try to reschedule a call the
    // guests already attended. A finished meeting leaves the invite in
    // create mode, which is the only thing that still makes sense.
    if (!upcomingMeeting) return;
    if (seededEventIdRef.current === upcomingMeeting.eventId) return;
    seededEventIdRef.current = upcomingMeeting.eventId;
    setMeetingState((prev) => meetingStateFromExisting(prev, upcomingMeeting));
  }, [upcomingMeeting]);

  // ── Template / AI apply, with overwrite confirmation ────────────────
  // Reply/forward never touch subject (it isn't shown inline).

  const applyTemplate = (template: MailTemplate) => {
    const run = () => {
      setBody(template.body);
      if (template.includesMeeting) setMeetingState(meetingStateFromTemplate(template));
    };
    const meetingConflict = template.includesMeeting && meetingState.enabled;
    if (body.trim() || meetingConflict) {
      setPendingApply({ kind: meetingConflict ? "meeting" : "body", run });
      return;
    }
    run();
  };

  const applyGenerated = (
    result: { body: string },
    meta: { wasUpdate: boolean },
  ) => {
    const previous = body;
    const run = () => setBody(result.body);

    // The user asked for this edit, so confirming it would be asking
    // permission for the thing just requested. Undo is the safety net instead.
    if (meta.wasUpdate) {
      run();
      toast.success("Draft updated", {
        action: { label: "Undo", onClick: () => setBody(previous) },
      });
      return;
    }

    if (previous.trim()) {
      setPendingApply({ kind: "body", run });
      return;
    }
    run();
  };

  // Fire an optional calendar invite after a successful send. Independent of
  // the send: never blocks it, offers a Retry on failure. `eventInput` is
  // built before onClose() unmounts this box.
  const fireMeeting = useCallback(
    (attendees: string[]) => {
      // This box has no attendee editor — `attendees` is inferred from the
      // reply's own To/Cc line. Fine as a guess on CREATE, but never sent on
      // a MOVE: updateEvent treats a supplied attendees array as the whole
      // guest list, so a recomputed subset would read as "everyone else was
      // removed" and cancel the meeting for them. `undefined` leaves the
      // event's real attendees untouched, the same way `title: undefined`
      // already does below.
      const isMovingMeeting = meetingState.mode === "update" && !!meetingState.target;
      const action = buildEventInput(
        meetingState,
        subject,
        isMovingMeeting ? undefined : attendees,
      );
      if (!action) return;

      if (action.kind === "update") {
        // A move never renames. This box has no title field, so
        // `action.input.title` is just the thread subject — which on a reply
        // carries a "Re: " prefix, and sending it would rename an existing
        // "Team sync" to "Re: Team sync" every time someone reschedules it.
        // Omitting it leaves the event's own title alone — updateEvent reads
        // the event and writes back only the fields named here.
        const moveInput = { ...action.input, title: undefined };
        const run = () =>
          updateEventAsync({ id: action.eventId, ...moveInput })
            .then(() => toast.success("Meeting moved"))
            .catch(() =>
              toast.error("Sent, but the meeting couldn't be moved", {
                action: { label: "Retry", onClick: run },
              }),
            );
        void run();
        return;
      }

      const run = () =>
        createEventAsync({ ...action.input, threadId, entityId })
          .then((event) => {
            if (event.linked) {
              toast.success("Calendar invite created");
              return;
            }
            // Partial success: the event exists, only the link is missing.
            // Deliberately no Retry — retrying would create a second event,
            // which is the exact bug this feature exists to prevent. Say what
            // happened instead, and point at the thing that does exist.
            toast.warning("Meeting created, but not linked to this thread", {
              description:
                "It's on your calendar — scheduling again here will create a second one.",
              ...(event.htmlLink
                ? {
                    action: {
                      label: "Open",
                      onClick: () => window.open(event.htmlLink, "_blank"),
                    },
                  }
                : {}),
            });
          })
          .catch(() =>
            // The create itself failed: nothing exists, so Retry is free.
            toast.error("Sent, but the calendar invite couldn't be created", {
              action: { label: "Retry", onClick: run },
            }),
          );
      void run();
    },
    [
      meetingState,
      subject,
      threadId,
      entityId,
      createEventAsync,
      updateEventAsync,
    ],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Scroll the box into view then focus the field the user actually needs to
  // fill in — reply/replyAll and draft-editing want the body, a fresh forward
  // wants the (empty) recipient. Without this, opening the box below a long
  // thread leaves the user looking at the top, unaware anything changed.
  useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    const t = setTimeout(() => {
      if (isFreshForward) recipientsRef.current?.focusField("to");
      else bodyRef.current?.focus();
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = useCallback(async () => {
    // Same rule as the compose dialog: bad addresses are tolerated while
    // typing and refused here, with the cursor put on the line at fault.
    const invalidField = firstInvalidRecipientField(recipients);
    if (invalidField) {
      toast.error("Check the recipient addresses");
      recipientsRef.current?.focusField(invalidField);
      return;
    }
    if (parseAddressList(recipients.to).length === 0) {
      toast.error(mode === "forward" ? "Add a recipient before forwarding" : "Add a recipient");
      recipientsRef.current?.focusField("to");
      return;
    }

    const { to, cc, bcc } = recipients;
    setSubmitting(true);
    try {
      if (draftId) {
        // sendDraft sends whatever Gmail currently has stored for this draft
        // id — local edits must be pushed first or they'd be silently dropped.
        // entityId/replyAll re-derive In-Reply-To/References on every push —
        // a draft opened here is always reply-shaped (see the comment below).
        await saveDraftAsync({
          to, cc, bcc, subject, body, threadId, draftId,
          entityId, replyAll: mode === "replyAll",
        });
        await sendDraftAsync({ draftId });
      } else if (mode === "forward") {
        await forwardEmailAsync({
          entityId, to, cc, bcc, note: body.trim() || undefined,
        });
      } else {
        // to/cc/bcc are passed explicitly, so what the user sees on screen is
        // what gets sent. Passing them also means an emptied Cc stays empty
        // rather than being re-derived server-side — see replyToEmail.
        await replyToEmailAsync({
          entityId, body, replyAll: mode === "replyAll", to, cc, bcc,
        });
      }
      toast.success("Sent");
      // Fire the optional calendar invite before onClose() unmounts the box.
      // To + Cc only: a Bcc'd address must not surface in an attendee list.
      fireMeeting(visibleRecipients(recipients));
      onSent();
      onClose();
    } catch (err) {
      toast.error("Couldn't send", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    draftId, recipients, subject, body, threadId, mode, entityId,
    saveDraftAsync, sendDraftAsync, forwardEmailAsync, replyToEmailAsync,
    onSent, onClose, fireMeeting,
  ]);

  const handleSaveDraft = useCallback(async () => {
    setSubmitting(true);
    try {
      await saveDraftAsync({
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject,
        body,
        threadId,
        ...(draftId ? { draftId } : {}),
        // Forward drafts have no "reply target" to derive headers from —
        // isFreshForward is the only case with no entityId/reply semantics.
        ...(isFreshForward ? {} : { entityId, replyAll: mode === "replyAll" }),
      });
      toast.success(draftId ? "Draft updated" : "Draft saved");
      onSent();
      onClose();
    } catch (err) {
      toast.error("Couldn't save draft", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    saveDraftAsync, recipients, subject, body, threadId, draftId,
    isFreshForward, entityId, mode, onClose, onSent,
  ]);

  const handleDiscard = useCallback(async () => {
    if (!draftId) {
      onClose();
      return;
    }
    setSubmitting(true);
    try {
      await discardDraftAsync({ draftId });
      toast.success("Draft discarded");
      onSent();
    } catch (err) {
      toast.error("Couldn't discard draft", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setSubmitting(false);
      onClose();
    }
  }, [draftId, discardDraftAsync, onClose, onSent]);

  const title = draftId
    ? "Editing draft"
    : mode === "forward"
      ? "Forward"
      : mode === "replyAll"
        ? "Reply All"
        : "Reply";

  return (
    <div ref={containerRef} className="bg-card border rounded-xl shadow-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          disabled={submitting}
          title="Close"
        >
          <XIcon className="size-4" />
        </Button>
      </div>

      <RecipientFields
        ref={recipientsRef}
        values={recipients}
        onChange={setRecipients}
        disabled={submitting}
        compact
      />

      {isFreshForward && <QuotedHistoryToggle quoted={quoted} variant="forward" alwaysOpen />}

      <div className="flex flex-wrap items-center gap-2">
        <TemplatePicker onSelect={applyTemplate} disabled={submitting} />
        <AiGeneratePanel
          mode={mode === "forward" ? "forward" : "reply"}
          context={{
            fromEmail: quoted.from,
            to: quoted.to,
            subject: quoted.subject,
            body: quoted.body,
          }}
          // The user's own reply so far. The quoted original is deliberately
          // not part of this — it travels as `context` above — so a fresh
          // reply reads as empty and still offers "Generate with AI".
          draftBody={body}
          // The invite attached to this reply, so the drafted body states its
          // real time rather than asking about availability for a slot the
          // invite already books.
          meeting={meetingTimesFor(meetingState) ?? undefined}
          onGenerated={applyGenerated}
          disabled={submitting}
        />
      </div>

      <Textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={mode === "forward" ? "Add a note (optional)…" : "Write your reply…"}
        disabled={submitting}
        rows={5}
        // resize-none stops the user dragging it taller, but field-sizing-content
        // on the base Textarea still grows it to fit — so a long reply, or one
        // the AI just expanded, walks the Send button down the thread. Cap it
        // and scroll inside instead.
        className="resize-none max-h-[45dvh] overflow-y-auto"
      />

      <MeetingInviteFields
        value={meetingState}
        onChange={setMeetingState}
        disabled={submitting}
        existing={upcomingMeeting}
        deletedLink={deletedLink}
        onAcknowledgeDeleted={(eventId) => void acknowledgeAsync({ eventId })}
      />

      {/*
        Reply/Reply All (fresh or resumed-as-draft) get the collapsed
        toggle — a draft only ever reaches this box when it was created as a
        reply (isReplyToExisting), so `draftId` set here always implies a
        reply-shaped quote, never a forward one.
      */}
      {!isFreshForward && <QuotedHistoryToggle quoted={quoted} variant="reply" />}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={handleDiscard} disabled={submitting}>
          <Trash2Icon className="size-3.5" />
          Discard
        </Button>
        <Button variant="outline" size="sm" onClick={handleSaveDraft} disabled={submitting}>
          <SaveIcon className="size-3.5" />
          {draftId ? "Update draft" : "Save as draft"}
        </Button>
        <Button size="sm" onClick={handleSend} disabled={submitting}>
          {submitting ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <SendIcon className="size-3.5" />
          )}
          Send
        </Button>
      </div>

      <AlertDialog
        open={!!pendingApply}
        onOpenChange={(next) => !next && setPendingApply(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingApply?.kind === "meeting"
                ? "Replace your current meeting details?"
                : "Replace your current reply text?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingApply?.kind === "meeting"
                ? "This template has its own meeting settings, which will overwrite the ones you've set."
                : "Your current reply will be replaced with the template."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => {
                pendingApply?.run();
                setPendingApply(null);
              }}
            >
              Replace
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
