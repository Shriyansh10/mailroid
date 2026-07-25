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
import { Input } from "@web/components/ui/input";
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
import { useCreateEvent } from "@web/hooks/api/calendar";
import { TemplatePicker, type MailTemplate } from "@web/components/inbox/template-picker";
import { AiGeneratePanel } from "@web/components/inbox/ai-generate-panel";
import {
  MeetingInviteFields,
  emptyMeetingState,
  meetingStateFromTemplate,
  buildEventInput,
  type MeetingState,
} from "@web/components/inbox/meeting-invite-fields";

export type InlineReplyMode = "reply" | "replyAll" | "forward";

/**
 * The message being replied to/forwarded. Used ONLY for display (the
 * recipient chip and the quoted-text preview) — never sent as-is. The actual
 * send goes through `replyToEmail`/`forwardEmail`, which independently
 * re-fetch this same message server-side and derive the authoritative
 * recipient/subject/threading headers from it. If this object were ever wrong
 * or stale, the worst outcome is a wrong-looking preview, never a
 * misdirected send.
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
  /** Reply/Reply All only: display-only recipient string (see QuotedMessage doc). Ignored for forward. */
  displayTo?: string;
  /**
   * Present when this box is resuming an existing draft (only ever true for
   * drafts flagged `isReplyToExisting` — see getDraft) — switches Send/Save/
   * Discard to the draft mutations and makes `to` editable regardless of mode.
   */
  draftId?: string;
  /** The subject to save the draft under. Never shown/edited inline — Gmail's own inline reply doesn't expose it either. */
  subject: string;
  initialTo?: string;
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
  displayTo,
  draftId,
  subject,
  initialTo,
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

  // `to` is editable whenever there's no fixed recipient to derive: forwarding
  // always needs one supplied, and resuming a draft edits whatever Gmail has
  // saved for it (a draft can be an in-progress reply-all whose recipients the
  // user already trimmed, which display-derived `to` would silently discard).
  const toEditable = mode === "forward" || Boolean(draftId);
  const isFreshForward = mode === "forward" && !draftId;

  const [to, setTo] = useState(initialTo ?? "");
  const [body, setBody] = useState(initialBody ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [meetingState, setMeetingState] = useState<MeetingState>(emptyMeetingState);
  const [pendingApply, setPendingApply] = useState<null | {
    kind: "body" | "meeting";
    run: () => void;
  }>(null);

  // The sender's bare address, for seeding calendar attendees on a reply.
  // Parsed from the display `from` the same way [threadId]/page.tsx does.
  const senderEmail = (() => {
    const match = quoted.from.match(/<([^>]+)>/);
    return match ? match[1]! : quoted.from;
  })();

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

  const applyGenerated = (result: { body: string }) => {
    const run = () => setBody(result.body);
    if (body.trim()) {
      setPendingApply({ kind: "body", run });
      return;
    }
    run();
  };

  // Fire an optional calendar invite after a successful send. Independent of
  // the send: never blocks it, offers a Retry on failure. `eventInput` is
  // built before onClose() unmounts this box.
  const fireMeeting = useCallback(
    (recipients: string[]) => {
      const eventInput = buildEventInput(meetingState, subject, recipients);
      if (!eventInput) return;
      const createEvent = () =>
        createEventAsync(eventInput)
          .then(() => toast.success("Calendar invite created"))
          .catch(() =>
            toast.error("Sent, but the calendar invite couldn't be created", {
              action: { label: "Retry", onClick: createEvent },
            }),
          );
      void createEvent();
    },
    [meetingState, subject, createEventAsync],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  // Scroll the box into view then focus the field the user actually needs to
  // fill in — reply/replyAll and draft-editing want the body, a fresh forward
  // wants the (empty) recipient. Without this, opening the box below a long
  // thread leaves the user looking at the top, unaware anything changed.
  useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    const focusTarget = mode === "forward" && !draftId ? toRef.current : bodyRef.current;
    const t = setTimeout(() => focusTarget?.focus(), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = useCallback(async () => {
    setSubmitting(true);
    try {
      if (draftId) {
        // sendDraft sends whatever Gmail currently has stored for this draft
        // id — local edits must be pushed first or they'd be silently dropped.
        // entityId/replyAll re-derive In-Reply-To/References on every push —
        // a draft opened here is always reply-shaped (see the comment below).
        await saveDraftAsync({
          to, subject, body, threadId, draftId,
          entityId, replyAll: mode === "replyAll",
        });
        await sendDraftAsync({ draftId });
      } else if (mode === "forward") {
        if (!to.trim()) {
          toast.error("Add a recipient before forwarding");
          setSubmitting(false);
          return;
        }
        await forwardEmailAsync({ entityId, to: to.trim(), note: body.trim() || undefined });
      } else {
        await replyToEmailAsync({ entityId, body, replyAll: mode === "replyAll" });
      }
      toast.success("Sent");
      // Fire the optional calendar invite before onClose() unmounts the box —
      // recipients are whatever this send actually used.
      fireMeeting(toEditable ? (to.trim() ? [to.trim()] : []) : [senderEmail]);
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
    draftId, to, subject, body, threadId, mode, entityId,
    saveDraftAsync, sendDraftAsync, forwardEmailAsync, replyToEmailAsync,
    onSent, onClose, fireMeeting, toEditable, senderEmail,
  ]);

  const handleSaveDraft = useCallback(async () => {
    setSubmitting(true);
    try {
      await saveDraftAsync({
        to: toEditable ? to : (displayTo ?? ""),
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
    saveDraftAsync, toEditable, to, displayTo, subject, body, threadId, draftId,
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

      {toEditable ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground shrink-0">To</span>
          <Input
            ref={toRef}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="recipient@example.com"
            disabled={submitting}
            className="h-8"
          />
        </div>
      ) : (
        displayTo && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>To</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-foreground">{displayTo}</span>
          </div>
        )
      )}

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
        className="resize-none"
      />

      <MeetingInviteFields value={meetingState} onChange={setMeetingState} disabled={submitting} />

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
                : "Your current reply will be replaced with the template or generated text."}
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
