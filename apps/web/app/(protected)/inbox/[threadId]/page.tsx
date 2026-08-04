"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  useThread,
  useTrashThread,
  useSetStarred,
  useSetRead,
  useDraft,
} from "@web/hooks/api/gmail";
import {
  useCreateEvent,
  useUpdateEvent,
  useDeleteEvent,
  useThreadMeetings,
  useAcknowledgeThreadMeeting,
} from "@web/hooks/api/calendar";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@web/components/ui/button";
import { Badge } from "@web/components/ui/badge";
import { Skeleton } from "@web/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@web/components/ui/alert";
import { Input } from "@web/components/ui/input";
import {
  ArrowLeft as ArrowLeftIcon,
  Reply as ReplyIcon,
  ReplyAll as ReplyAllIcon,
  Forward as ForwardIcon,
  Calendar as CalendarIcon,
  AlertCircle as AlertCircleIcon,
  Trash2 as Trash2Icon,
  Star as StarIcon,
} from "lucide-react";
import { cn } from "@web/lib/utils";
import { EmailSummaryCard } from "@web/components/email-summary-card";
import { ThreadMessageList } from "@web/components/thread-message-list";
import { InlineReplyBox } from "@web/components/inbox/inline-reply-box";
import type { InlineReplyMode } from "@web/components/inbox/inline-reply-box";
import { useSession } from "@web/lib/auth-client";
import {
  dedupeAddresses,
  joinAddresses,
  parseAddressList,
  removeAddresses,
} from "@web/lib/email-addresses";
import {
  emptyMeetingState,
  meetingStateFromExisting,
  buildEventInput,
  type MeetingState,
} from "@web/components/inbox/meeting-invite-fields";
import { ThreadMeetingCard } from "@web/components/inbox/thread-meeting-card";
import {
  toLocalDateKey,
  parseLocalDateKey,
  parseTimeInput,
  parseDurationInput,
} from "@web/components/calendar/event-form-utils";

/**
 * `<input type="time">` needs 24-hour `HH:mm`. MeetingState holds whatever
 * form the value came in as — "10:00" from this form, but "5:00 PM" when
 * seeded from an existing meeting — so normalize on the way into the input.
 */
function toTimeInputValue(raw: string): string {
  const minutes = parseTimeInput(raw);
  if (minutes === null) return "";
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Which action opened the inline box, and — separately — whether it's
 * resuming an already-saved draft. These are orthogonal (see
 * inline-reply-box.tsx): switching action while a draft is open should start
 * fresh rather than silently keep editing the old draft under a new label,
 * which is exactly what keeping them as one object instead of two pieces of
 * state prevents.
 */
type BoxState = { mode: InlineReplyMode; draftId?: string } | null;

export default function ThreadDetailPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const { data: thread, isLoading, isError, error, refetch: refetchThread } = useThread(threadId);
  const router = useRouter();
  const searchParams = useSearchParams();
  // Your own address, so Reply All doesn't seed a Cc that copies you.
  const { data: session } = useSession();
  const myEmail = session?.user?.email ?? "";

  // Where "Back to Inbox" should return to — the exact list view (category,
  // q, aiq, mode, page) the user came from, carried forward as `from` by
  // DossierLayout's buildThreadHref (see page.tsx). Restricted to internal
  // /inbox paths only, so this can never become an open redirect if `from`
  // were ever tampered with in the URL.
  const rawFrom = searchParams.get("from");
  const backHref = rawFrom && rawFrom.startsWith("/inbox") ? rawFrom : "/inbox";

  const [isScheduling, setIsScheduling] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("");
  // Date/time/duration live in the shared MeetingState so this form goes
  // through the same buildEventInput as the compose surfaces — including its
  // create-vs-move decision. The dossier chrome below is unchanged; only the
  // state behind it moved.
  const [meetingState, setMeetingState] = useState<MeetingState>(emptyMeetingState);
  const [submittingMeeting, setSubmittingMeeting] = useState(false);

  const { trashThreadAsync } = useTrashThread();
  const { setStarredAsync } = useSetStarred();
  // Local echo of the star. The thread detail payload doesn't carry starred
  // state, so this reflects what the user has done while the thread is open
  // rather than pretending to know the server value.
  const [starred, setStarred] = useState(false);

  const handleToggleStar = async () => {
    const next = !starred;
    setStarred(next);
    try {
      await setStarredAsync({ threadId, starred: next });
      toast.success(next ? "Starred" : "Unstarred");
    } catch (err) {
      setStarred(!next);
      toast.error("Couldn't update star", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    }
  };

  // Opening a thread marks it read, in Gmail and locally — otherwise nothing
  // in the app ever clears UNREAD and every row in the list stays bold
  // forever. Guarded by a ref keyed on threadId so a background refetch of the
  // thread can't re-fire it, and deliberately silent: a failed read-marking is
  // not worth interrupting reading the mail over.
  const { setReadAsync } = useSetRead();
  const markedReadRef = useRef<string | null>(null);

  useEffect(() => {
    if (!thread || markedReadRef.current === threadId) return;
    markedReadRef.current = threadId;
    void setReadAsync({ threadId, read: true }).catch(() => {});
  }, [thread, threadId, setReadAsync]);

  /** Bin the thread and leave the detail view — the thread is no longer here. */
  const handleMoveToBin = async () => {
    try {
      await trashThreadAsync({ threadId });
      toast.success("Moved to Bin", {
        description: "Gmail keeps binned mail for about 30 days.",
      });
      router.push("/inbox");
    } catch (err) {
      toast.error("Couldn't move to Bin", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    }
  };

  // Drafts are unsent — Gmail groups them into the thread by threadId, but a
  // draft is never what a reply should target. "Last message" means the last
  // real (non-draft) message, not the first, and not a trailing draft either.
  const realMessages = useMemo(
    () => thread?.messages?.filter((m) => !m.isDraft) ?? [],
    [thread],
  );
  const lastMsg = realMessages[realMessages.length - 1];

  // A draft left sitting at the end of this thread (e.g. a reply saved
  // earlier and never sent) — Gmail shows it inline, editable, in place of a
  // normal message row; this page does the same via the InlineReplyBox.
  const trailingDraft = thread?.messages?.find((m) => m.isDraft);

  /**
   * Who a reply goes to. Reply-To wins over From when the message set one —
   * mailing lists and no-reply senders depend on it, and this line is now what
   * actually gets sent (the box passes its recipients through), so getting it
   * from the same header resolveReplyTarget uses is not optional.
   */
  const senderEmail = useMemo(
    () => parseAddressList(lastMsg?.replyTo || lastMsg?.from)[0] ?? "",
    [lastMsg],
  );

  /**
   * Everyone else the last message reached — the Cc line a Reply All starts
   * with. Mirrors resolveReplyTarget's server-side rule: drop the sender (who
   * is the To of this reply) and drop yourself (Gmail doesn't copy you on your
   * own reply). Both lists are editable afterwards, so this only has to be a
   * sensible starting point, not the last word.
   */
  const replyAllCc = useMemo(() => {
    if (!lastMsg) return "";
    const everyone = parseAddressList(`${lastMsg.to ?? ""},${lastMsg.cc ?? ""}`);
    return joinAddresses(
      dedupeAddresses(removeAddresses(everyone, [senderEmail, myEmail])),
    );
  }, [lastMsg, senderEmail, myEmail]);

  useEffect(() => {
    if (thread) {
      setMeetingTitle(`Discussion: ${thread.subject || "Untitled"}`);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      setMeetingState({
        ...emptyMeetingState(),
        enabled: true,
        date: tomorrow,
        startTime: "10:00",
        duration: "60",
      });
      setIsScheduling(false);
    }
  }, [thread]);

  const { createEventAsync } = useCreateEvent();
  const { updateEventAsync } = useUpdateEvent();
  const { deleteEventAsync } = useDeleteEvent();
  const { primaryMeeting, deletedLink } = useThreadMeetings(threadId);
  const { acknowledgeAsync } = useAcknowledgeThreadMeeting();

  // Seed from the thread's existing meeting so "Schedule Meeting" moves it
  // rather than adding a second one. Once per event id, so an explicit choice
  // to create another isn't undone by a refetch.
  const seededEventIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!primaryMeeting) return;
    if (seededEventIdRef.current === primaryMeeting.eventId) return;
    seededEventIdRef.current = primaryMeeting.eventId;
    setMeetingState((prev) => meetingStateFromExisting(prev, primaryMeeting));
  }, [primaryMeeting]);

  // Cancelling from the card. The tRPC delete route already closes the thread
  // link as CANCELLED, so there is no second call to keep in step.
  const [isCancellingMeeting, setIsCancellingMeeting] = useState(false);
  const handleCancelMeeting = async () => {
    if (!primaryMeeting) return;
    if (
      !window.confirm(
        `Cancel "${primaryMeeting.title}"? Attendees will be notified.`,
      )
    ) {
      return;
    }
    setIsCancellingMeeting(true);
    try {
      await deleteEventAsync({ id: primaryMeeting.eventId });
      toast.success("Meeting cancelled", {
        description: "Attendees have been notified",
      });
      // The form may still be open in "move" mode pointing at the event that
      // no longer exists.
      setIsScheduling(false);
      setMeetingState((prev) => ({ ...prev, mode: "create", target: undefined }));
      seededEventIdRef.current = null;
    } catch (err: unknown) {
      toast.error("Couldn't cancel the meeting", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setIsCancellingMeeting(false);
    }
  };

  const handleConfirmMeeting = async (e: React.FormEvent) => {
    e.preventDefault();

    const action = buildEventInput(
      { ...meetingState, enabled: true },
      meetingTitle,
      senderEmail ? [senderEmail] : [],
    );
    if (!action) {
      toast.error("Check the meeting date, time and duration");
      return;
    }

    const description = `Scheduled from Mailroid Dossier: ${thread?.subject || ""}\nSender: ${lastMsg?.from}`;

    setSubmittingMeeting(true);
    try {
      if (action.kind === "update") {
        await updateEventAsync({
          id: action.eventId,
          ...action.input,
          description,
        });
        toast.success("Meeting moved", {
          description: `Attendees have been notified`,
        });
      } else {
        const event = await createEventAsync({
          ...action.input,
          description,
          threadId,
          ...(lastMsg?.id ? { entityId: lastMsg.id } : {}),
        });
        if (event.linked) {
          toast.success("Meeting Scheduled", {
            description: `Successfully scheduled with ${senderEmail}`,
          });
        } else {
          // The event exists; only the link failed. No retry affordance —
          // retrying would schedule a second meeting.
          toast.warning("Meeting created, but not linked to this thread", {
            description:
              "It's on your calendar — scheduling again here will create a second one.",
          });
        }
      }
      setIsScheduling(false);
    } catch (err: any) {
      console.error(err);
      toast.error("Failed to schedule meeting", {
        description: err.message || "An unknown error occurred",
      });
    } finally {
      setSubmittingMeeting(false);
    }
  };

  // ── Inline reply / forward ─────────────────────────────────────────

  const [box, setBox] = useState<BoxState>(null);

  const handleReply = () => setBox({ mode: "reply" });
  const handleReplyAll = () => setBox({ mode: "replyAll" });
  const handleForward = () => setBox({ mode: "forward" });

  // Resuming a draft from the Draft view: /inbox/[threadId]?draftId=... —
  // fetch it and auto-open the box, once per distinct draftId (a ref, not a
  // dependency on the query's data object, so a background refetch triggered
  // by the send/save mutations below can't reopen a box the user closed).
  const resumeDraftId = searchParams.get("draftId") ?? undefined;
  // Also covers the trailing-draft case below, so a resumed draft always comes
  // from getDraft whichever way it was opened. That's not just tidiness: the
  // thread's own copy of a draft message has no Bcc line (message detail
  // deliberately doesn't carry one — Gmail strips Bcc from delivered mail), so
  // prefilling from it would quietly drop the Bcc off a draft that has one.
  const { data: resumedDraft } = useDraft(resumeDraftId ?? trailingDraft?.draftId);
  const autoOpenedRef = useRef<string | null>(null);

  useEffect(() => {
    if (resumeDraftId && resumedDraft && autoOpenedRef.current !== resumeDraftId) {
      autoOpenedRef.current = resumeDraftId;
      // Any non-forward mode is correct here: a draft only ever reaches this
      // page when getDraft flagged it isReplyToExisting (see the Draft view's
      // click handler), so it is always reply-shaped, never a forward.
      setBox({ mode: "reply", draftId: resumeDraftId });
    }
  }, [resumeDraftId, resumedDraft]);

  // Landing directly on a thread that already ends in a draft (e.g. via a
  // link, or a refresh) — open it the same way, without needing a
  // `?draftId=` in the URL. Skipped whenever resumeDraftId is driving the box
  // instead, so the two auto-open paths never race each other.
  useEffect(() => {
    if (
      !resumeDraftId &&
      trailingDraft?.draftId &&
      autoOpenedRef.current !== trailingDraft.draftId
    ) {
      autoOpenedRef.current = trailingDraft.draftId;
      setBox({ mode: "reply", draftId: trailingDraft.draftId });
    }
  }, [resumeDraftId, trailingDraft]);

  const closeBox = () => {
    setBox(null);
    if (resumeDraftId) {
      // Strip ?draftId= so a refresh doesn't reopen an already-handled draft
      // — but keep ?from= intact, or Back to Inbox would forget the list
      // view this thread was opened from.
      router.replace(rawFrom ? `/inbox/${threadId}?from=${encodeURIComponent(rawFrom)}` : `/inbox/${threadId}`);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <Skeleton className="h-4 w-28" />
        <div className="space-y-2">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-4 w-36" />
        </div>
        <Skeleton className="h-24 w-full rounded-xl" />
        <div className="space-y-4">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <Alert variant="destructive" className="mb-6">
          <AlertCircleIcon className="h-4 w-4" />
          <AlertTitle>Error Loading Thread</AlertTitle>
          <AlertDescription>
            {error?.message ?? "An unexpected error occurred while retrieving this thread."}
          </AlertDescription>
        </Alert>
        <Button onClick={() => router.push(backHref)} variant="outline">
          <ArrowLeftIcon className="mr-2 h-4 w-4" />
          Back to Inbox
        </Button>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8 text-center space-y-4">
        <h2 className="text-xl font-semibold">Thread Not Found</h2>
        <p className="text-muted-foreground">The requested thread does not exist or you do not have permission to view it.</p>
        <Button onClick={() => router.push(backHref)} variant="outline">
          <ArrowLeftIcon className="mr-2 h-4 w-4" />
          Back to Inbox
        </Button>
      </div>
    );
  }

  const quoted = lastMsg
    ? {
        from: lastMsg.from,
        to: lastMsg.to,
        subject: thread.subject,
        date: lastMsg.date,
        body: lastMsg.body || lastMsg.snippet,
      }
    : { from: "", to: "", subject: thread.subject, date: "", body: "" };

  // The draft's own fields, from getDraft — whether it was opened via
  // `?draftId=` from the Draft list or detected as this thread's trailing
  // draft, useDraft above fetches the same resource. Guarded on the ids
  // matching so the box never prefills from a draft it isn't editing (a stale
  // query result while switching drafts).
  const activeDraft =
    box?.draftId && box.draftId === resumedDraft?.draftId ? resumedDraft : undefined;

  // What the three recipient lines open with. A draft resumes exactly what
  // Gmail has stored for it (including a Bcc, which survives on drafts alone);
  // otherwise the seed is per-mode, and a forward starts blank so the user
  // can't accidentally send the whole quoted thread back to its own sender.
  const prefillRecipients = box?.draftId
    ? { initialTo: activeDraft?.to, initialCc: activeDraft?.cc, initialBcc: activeDraft?.bcc }
    : box?.mode === "replyAll"
      ? { initialTo: senderEmail, initialCc: replyAllCc }
      : box?.mode === "reply"
        ? { initialTo: senderEmail }
        : {};

  const boxSubject = box?.draftId
    ? (activeDraft?.subject ?? thread.subject)
    : box?.mode === "forward"
      ? (/^fwd:/i.test(thread.subject) ? thread.subject : `Fwd: ${thread.subject}`)
      : (/^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Back link */}
      <div className="mb-5">
        <Link
          href={backHref}
          className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider"
        >
          <ArrowLeftIcon className="size-3.5" /> Back to Inbox
        </Link>
      </div>

      {/* Subject Line & Meta */}
      <div className="space-y-2 mb-4 pb-4 border-b">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-serif font-bold tracking-tight text-foreground leading-tight">
            {thread.subject || "(No Subject)"}
          </h1>
          {thread.priority && (
            <Badge
              variant={thread.priority === "HIGH" ? "destructive" : thread.priority === "LOW" ? "secondary" : "outline"}
              className={cn(
                "font-mono text-[9px] font-bold tracking-widest uppercase rounded px-2 py-0.5 select-none shrink-0",
                thread.priority === "MEDIUM" && "text-amber-600 border-amber-600/30 bg-amber-500/10"
              )}
            >
              {thread.priority} PRIORITY
            </Badge>
          )}
        </div>
        <p className="text-xs font-mono text-muted-foreground select-none">
          {thread.messages.length} {thread.messages.length === 1 ? "message" : "messages"} on file
        </p>
      </div>

      {/*
        Top action bar. Icon-only, Gmail-style. Same handlers as the bottom
        pill bar below — no duplicated logic, just two entry points to the
        same actions.
      */}
      <div className="flex items-center gap-1 mb-6 pb-2 border-b">
        <Button variant="ghost" size="icon" className="size-8" onClick={handleToggleStar} title={starred ? "Unstar" : "Star"}>
          <StarIcon className={cn("size-4", starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={handleReply} title="Reply">
          <ReplyIcon className="size-4 text-muted-foreground" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={handleReplyAll} title="Reply All">
          <ReplyAllIcon className="size-4 text-muted-foreground" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={handleForward} title="Forward">
          <ForwardIcon className="size-4 text-muted-foreground" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 relative"
          onClick={() => setIsScheduling((s) => !s)}
          title={primaryMeeting ? "Move this thread's meeting" : "Schedule Meeting"}
        >
          <CalendarIcon className={cn("size-4", isScheduling ? "text-primary" : "text-muted-foreground")} />
          {/* Without the dot this icon looks identical whether the thread has
              a meeting or not, so there was no reason to ever click it. */}
          {primaryMeeting && (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 hover:text-destructive"
          onClick={handleMoveToBin}
          title="Move to Bin"
        >
          <Trash2Icon className="size-4 text-muted-foreground" />
        </Button>
      </div>

      {isScheduling && (
        <form onSubmit={handleConfirmMeeting} className="mb-6 p-4 rounded-xl border bg-card space-y-3">
          <div className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground font-bold">
            {meetingState.mode === "update" && meetingState.target
              ? "Move this thread's meeting"
              : "Schedule a meeting"}
          </div>

          {/* The deleted-link warning lives on ThreadMeetingCard above, not
              here — it is thread state, not form state, and belongs where the
              user sees it before opening anything. */}

          {meetingState.mode === "update" && meetingState.target && primaryMeeting && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-muted/60 px-2 py-1.5 text-[10px]">
              <span className="text-muted-foreground">
                Moving the existing meeting — attendees will be notified.
              </span>
              <button
                type="button"
                className="font-mono uppercase underline underline-offset-2"
                onClick={() =>
                  setMeetingState((prev) => ({
                    ...prev,
                    mode: "create",
                    target: undefined,
                  }))
                }
              >
                Create a second meeting
              </button>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-[9px] text-muted-foreground uppercase font-mono">Title</label>
            <Input
              type="text"
              value={meetingTitle}
              onChange={(e) => setMeetingTitle(e.target.value)}
              className="h-8 text-xs font-serif bg-transparent"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[9px] text-muted-foreground uppercase font-mono">Date</label>
              <Input
                type="date"
                value={meetingState.date ? toLocalDateKey(meetingState.date) : ""}
                onChange={(e) =>
                  setMeetingState((prev) => ({
                    ...prev,
                    date: parseLocalDateKey(e.target.value) ?? undefined,
                  }))
                }
                className="h-8 text-xs font-mono px-2 bg-transparent"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-[9px] text-muted-foreground uppercase font-mono">Time</label>
              <Input
                type="time"
                value={toTimeInputValue(meetingState.startTime)}
                onChange={(e) =>
                  setMeetingState((prev) => ({ ...prev, startTime: e.target.value }))
                }
                className="h-8 text-xs font-mono px-2 bg-transparent"
                required
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[9px] text-muted-foreground uppercase font-mono">Duration</label>
            <select
              value={String(parseDurationInput(meetingState.duration) ?? 60)}
              onChange={(e) =>
                setMeetingState((prev) => ({ ...prev, duration: e.target.value }))
              }
              className="w-full h-8 bg-transparent border border-input rounded px-2 text-xs font-mono outline-none"
            >
              <option value="30">30m</option>
              <option value="60">1h</option>
              <option value="90">1.5h</option>
              <option value="120">2h</option>
            </select>
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <Button
              size="sm"
              variant="ghost"
              type="button"
              className="h-7 text-[10px] font-mono uppercase px-2"
              onClick={() => setIsScheduling(false)}
            >
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={submittingMeeting} className="h-7 text-[10px] font-mono uppercase">
              {submittingMeeting
                ? "Saving..."
                : meetingState.mode === "update" && meetingState.target
                  ? "Move"
                  : "Confirm"}
            </Button>
          </div>
        </form>
      )}

      <div className="space-y-6">
        {/* The thread's meeting, if it has one. Rendered before the summary so
            "this mail has a meeting attached" is the first thing seen — the
            link existed for a while before anything displayed it, which meant
            the only way to discover a meeting was to click an unlabelled
            calendar icon and hope. */}
        {(primaryMeeting || deletedLink) && (
          <ThreadMeetingCard
            meeting={primaryMeeting}
            deletedLink={deletedLink}
            busy={submittingMeeting || isCancellingMeeting}
            onReschedule={() => setIsScheduling(true)}
            onCancel={handleCancelMeeting}
            onAcknowledgeDeleted={(eventId) => void acknowledgeAsync({ eventId })}
          />
        )}

        {/* On-demand AI summary. Previously this card rendered priorityReason
            (a classification rationale) or, failing that, the raw Gmail
            snippet — neither of which was a summary, and the snippet leaked
            whatever the email happened to contain. */}
        {/* Keyed to the NEWEST message, not the oldest. The summary covers
            the whole thread, and keying it to the latest message is what
            makes a new reply a cache miss — no version column, no timestamp
            comparison. It also fixes the original bug: with the oldest
            message as the key, a thread whose first message said "Test" was
            all the summarizer ever saw. */}
        <EmailSummaryCard
          entityId={thread.messages[thread.messages.length - 1]?.id}
          threadId={thread.threadId}
          messageCount={thread.messages.length}
          subject={thread.subject}
          sender={thread.messages[thread.messages.length - 1]?.from}
          receivedAt={thread.messages[thread.messages.length - 1]?.date}
          initialSummary={thread.summary}
          initialDigest={thread.summaryDigest}
          initialFullText={thread.summaryFullText}
          initialFlags={thread.summaryFlags}
          initialData={thread.summaryData}
        />

        {/* Email Messages Timeline */}
        <ThreadMessageList messages={thread.messages} selfEmail={myEmail} />

        {/* Bottom pill bar — same handlers as the top icon bar. */}
        <div className="flex items-center gap-2 pt-2">
          <Button variant="outline" className="rounded-full" onClick={handleReply}>
            <ReplyIcon className="size-3.5" />
            Reply
          </Button>
          <Button variant="outline" className="rounded-full" onClick={handleReplyAll}>
            <ReplyAllIcon className="size-3.5" />
            Reply All
          </Button>
          <Button variant="outline" className="rounded-full" onClick={handleForward}>
            <ForwardIcon className="size-3.5" />
            Forward
          </Button>
        </div>

        {box && lastMsg && (
          <InlineReplyBox
            mode={box.mode}
            threadId={thread.threadId}
            entityId={lastMsg.id}
            quoted={quoted}
            draftId={box.draftId}
            subject={boxSubject}
            {...prefillRecipients}
            initialBody={box.draftId ? activeDraft?.body : undefined}
            onClose={closeBox}
            onSent={() => void refetchThread()}
          />
        )}
      </div>
    </div>
  );
}
