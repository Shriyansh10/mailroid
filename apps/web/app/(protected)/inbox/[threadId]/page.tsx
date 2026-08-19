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
import { StaleThreadBanner } from "@web/components/inbox/stale-thread-banner";
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
  MeetingInviteFields,
  type MeetingState,
  type ThreadMeeting,
} from "@web/components/inbox/meeting-invite-fields";
import { ThreadMeetingCard } from "@web/components/inbox/thread-meeting-card";
// The same rule the server's write guards use — see @repo/shared/calendar.
import { isUpcomingMeeting } from "@repo/shared/calendar";
import {
  formatDuration,
  formatMeetingWindow,
  formatTimeOfDay,
} from "@web/components/calendar/event-form-utils";

/**
 * Which action opened the inline box, and — separately — whether it's
 * resuming an already-saved draft. These are orthogonal (see
 * inline-reply-box.tsx): switching action while a draft is open should start
 * fresh rather than silently keep editing the old draft under a new label,
 * which is exactly what keeping them as one object instead of two pieces of
 * state prevents.
 */
type BoxState = {
  mode: InlineReplyMode;
  draftId?: string;
  /**
   * Text to open the box with, for actions that have something to say before
   * the user does — currently only "propose a new time". Distinct from a
   * resumed draft: this is a suggestion the user is expected to edit, not
   * their own saved words.
   */
  seedBody?: string;
} | null;

export default function ThreadDetailPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const {
    data: thread,
    isLoading,
    isError,
    error,
    refetch: refetchThread,
    isFetching: isFetchingThread,
  } = useThread(threadId);
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
   * Whether the thread's LAST message was sent by this account, rather than
   * received — you checking back on a thread you started, or the last word in
   * a back-and-forth. Determines which header a reply should target, below.
   */
  const lastMsgIsFromSelf = useMemo(() => {
    if (!lastMsg || !myEmail) return false;
    const from = parseAddressList(lastMsg.from)[0] ?? "";
    return from.toLowerCase() === myEmail.toLowerCase();
  }, [lastMsg, myEmail]);

  /**
   * Who a reply goes to. Reply-To wins over From when the message set one —
   * mailing lists and no-reply senders depend on it, and this line is now what
   * actually gets sent (the box passes its recipients through), so getting it
   * from the same header resolveReplyTarget uses is not optional.
   *
   * Except when the last message is one YOU sent: From/Reply-To is then your
   * own address, and pre-filling a reply back to yourself is wrong — Gmail
   * continues the conversation with whoever the message actually went to
   * instead. That's the message's own To line, not its From.
   */
  const senderEmail = useMemo(() => {
    if (!lastMsg) return "";
    if (lastMsgIsFromSelf) {
      return parseAddressList(lastMsg.to)[0] ?? "";
    }
    return parseAddressList(lastMsg.replyTo || lastMsg.from)[0] ?? "";
  }, [lastMsg, lastMsgIsFromSelf]);

  /**
   * Everyone else the last message reached — the Cc line a Reply All starts
   * with. Mirrors resolveReplyTarget's server-side rule: drop the sender (who
   * is the To of this reply) and drop yourself (Gmail doesn't copy you on your
   * own reply). Both lists are editable afterwards, so this only has to be a
   * sensible starting point, not the last word.
   *
   * No separate self-sent branch needed here: `everyone` is read from the
   * message's own To/Cc regardless of direction, and `senderEmail` above
   * already resolves to the right primary recipient either way — so removing
   * it (and yourself) from that list lands on the right Cc set for both a
   * received message and one you sent.
   */
  const replyAllCc = useMemo(() => {
    if (!lastMsg) return "";
    const everyone = parseAddressList(`${lastMsg.to ?? ""},${lastMsg.cc ?? ""}`);
    return joinAddresses(
      dedupeAddresses(removeAddresses(everyone, [senderEmail, myEmail])),
    );
  }, [lastMsg, senderEmail, myEmail]);

  // Keyed on the *subject*, not on `thread`. The query result is a new object
  // on every refetch, so keying this on `thread` re-ran it while the form was
  // open — which is how the meeting form used to reset itself mid-edit.
  useEffect(() => {
    if (!thread) return;
    setMeetingTitle(`Discussion: ${thread.subject || "Untitled"}`);
    // `thread` is deliberately not a dependency: only the subject is read, and
    // depending on the query object is the defect this effect was split to fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.subject]);

  const { createEventAsync } = useCreateEvent();
  const { updateEventAsync } = useUpdateEvent();
  const { deleteEventAsync } = useDeleteEvent();
  const {
    meetings: threadMeetings,
    upcomingMeetings,
    upcomingMeeting,
    deletedLink,
  } = useThreadMeetings(threadId);
  const { acknowledgeAsync } = useAcknowledgeThreadMeeting();

  const seededEventIdRef = useRef<string | null>(null);
  const defaultsSeededRef = useRef<string | null>(null);

  // Per-thread reset and defaults. Guarded by a ref keyed on threadId so it
  // runs exactly once per thread and never on a refetch — the previous version
  // reset date/time/mode on every refetch, silently turning a reschedule back
  // into "create a second meeting at tomorrow 10:00".
  //
  // The defaults only apply when the thread has no meeting; when it has one the
  // effect below is the sole writer. The two queries settle in either order, so
  // this deliberately doesn't assume which arrives first: it runs once, and the
  // meeting seed overwrites it whenever the meeting turns up.
  useEffect(() => {
    if (defaultsSeededRef.current === threadId) return;
    defaultsSeededRef.current = threadId;
    // A different thread means a different (or no) meeting to move.
    seededEventIdRef.current = null;
    setIsScheduling(false);
    // `upcomingMeeting` is null both when there is nothing live to move and
    // when there are SEVERAL — see the hook. Both get create-mode defaults,
    // which is right in both cases: with several, nothing here says which one
    // the user means, so the form must not pre-aim at one of them. Pressing
    // Reschedule on a specific card is what supplies the missing referent.
    if (upcomingMeeting) return;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setMeetingState({
      ...emptyMeetingState(),
      enabled: true,
      date: tomorrow,
      startTime: formatTimeOfDay(10 * 60),
      duration: formatDuration(60),
    });
  }, [threadId, upcomingMeeting]);

  // Seed from the thread's existing meeting so "Reschedule" moves it rather
  // than adding a second one. Once per event id, so an explicit choice to
  // create another isn't undone by a refetch.
  useEffect(() => {
    // Deliberately `upcomingMeeting`. Seeding from a finished meeting is what
    // put the form into update mode against something that already happened —
    // pressing Confirm would move a meeting the guests had already attended,
    // and the server now refuses it. The form must not get there.
    if (!upcomingMeeting) return;
    if (seededEventIdRef.current === upcomingMeeting.eventId) return;
    seededEventIdRef.current = upcomingMeeting.eventId;
    setMeetingState((prev) => meetingStateFromExisting(prev, upcomingMeeting));
  }, [upcomingMeeting]);

  // Cancelling from the card. The tRPC delete route already closes the thread
  // link as CANCELLED, so there is no second call to keep in step.
  // The event id currently being cancelled, not a bare boolean: a thread can
  // show several cards, and one shared flag would grey out every meeting's
  // buttons because one of them is mid-delete.
  const [cancellingEventId, setCancellingEventId] = useState<string | null>(null);
  const handleCancelMeeting = async (meeting: ThreadMeeting) => {
    if (
      !window.confirm(`Cancel "${meeting.title}"? Attendees will be notified.`)
    ) {
      return;
    }
    setCancellingEventId(meeting.eventId);
    try {
      await deleteEventAsync({ id: meeting.eventId });
      toast.success("Meeting cancelled", {
        description: "Attendees have been notified",
      });
      // The form may still be open in "move" mode pointing at the event that
      // no longer exists — but only if it was pointing at THIS one. Resetting
      // unconditionally would silently turn a reschedule of a different
      // meeting back into "create a new one" mid-edit.
      if (meetingState.target?.eventId === meeting.eventId) {
        setIsScheduling(false);
        setMeetingState((prev) => ({ ...prev, mode: "create", target: undefined }));
        seededEventIdRef.current = null;
      }
    } catch (err: unknown) {
      toast.error("Couldn't cancel the meeting", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setCancellingEventId(null);
    }
  };

  /**
   * Open the form to move ONE named meeting.
   *
   * Explicit rather than inferred: with more than one meeting on the thread
   * the auto-seed below deliberately does nothing, so pressing Reschedule on a
   * card is the only thing that says which meeting is meant. The ref is
   * stamped too, so the auto-seed effect can't overwrite the choice on the
   * next refetch.
   */
  const startReschedule = (meeting: ThreadMeeting) => {
    seededEventIdRef.current = meeting.eventId;
    setMeetingState((prev) => meetingStateFromExisting(prev, meeting));
    setIsScheduling(true);
  };

  /**
   * Open the form to create a NEW meeting, whatever it was last pointing at.
   *
   * The reset is the whole function. Without it, a thread holding one finished
   * meeting and one live one would have auto-seeded the form into "move the
   * live one", and pressing "Schedule a new meeting" on the finished card
   * would move that other meeting instead — the exact silent-wrong-target this
   * work exists to close.
   */
  const startNewMeeting = () => {
    seededEventIdRef.current = null;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setMeetingState({
      ...emptyMeetingState(),
      enabled: true,
      date: tomorrow,
      startTime: formatTimeOfDay(10 * 60),
      duration: formatDuration(60),
    });
    setIsScheduling(true);
  };

  /** Whether submitting moves the thread's meeting or creates a new one. */
  const isMovingMeeting = meetingState.mode === "update" && !!meetingState.target;

  // The meeting the open form is pointing at, resolved from the form's own
  // target rather than from "the thread's meeting" — with several on the
  // thread those are different meetings, and the banner naming the wrong one
  // is how a user confirms a move they didn't intend.
  const movingMeeting =
    threadMeetings.find((m) => m.eventId === meetingState.target?.eventId) ?? null;

  /**
   * Cards in reading order: what is coming up, soonest first, then history,
   * most recent first.
   *
   * The wire order is `createdAt` desc — right for "which meeting did I just
   * make", wrong for a list someone is scanning. With one card it never
   * mattered; with several, a call from last month sitting above tomorrow's
   * makes the reader do the sorting.
   */
  const orderedMeetings = [...threadMeetings].sort((a, b) => {
    const aUpcoming = isUpcomingMeeting(a);
    if (aUpcoming !== isUpcomingMeeting(b)) return aUpcoming ? -1 : 1;
    const delta = Date.parse(a.start) - Date.parse(b.start);
    return aUpcoming ? delta : -delta;
  });

  // The form now renders under the meeting card, well below the button that
  // opens it on a long thread, so opening it has to bring it into view.
  const scheduleFormRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!isScheduling) return;
    scheduleFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [isScheduling]);

  const handleConfirmMeeting = async (e: React.FormEvent) => {
    e.preventDefault();

    // This form has no attendee editor — it only ever infers a single address
    // from whichever message is currently last in the thread. That's a fine
    // guess for who to invite on CREATE, but on a MOVE it must never be sent:
    // updateEvent treats a supplied attendees array as the complete guest
    // list, so a recomputed single-address list would read as "everyone else
    // was removed" and cancel the meeting for them. Passing `undefined`
    // leaves the event's real attendees untouched.
    const action = buildEventInput(
      { ...meetingState, enabled: true },
      meetingTitle,
      isMovingMeeting ? undefined : (senderEmail ? [senderEmail] : []),
      {
        descriptionFallback: isMovingMeeting
          ? undefined
          : `Scheduled from Mailroid Dossier: ${thread?.subject || ""}\nSender: ${lastMsg?.from}`,
      },
    );
    if (!action) {
      toast.error("Check the meeting date, time and duration");
      return;
    }

    setSubmittingMeeting(true);
    try {
      if (action.kind === "update") {
        // A move never renames. The form hides the Title field here because
        // the only value it could carry is "Discussion: Re: …", which would
        // rename an existing "Team sync" every time somebody rescheduled it.
        // Omitting it leaves the event's own title alone — updateEvent reads
        // the event and writes back only the fields named here. Same reason
        // there is no `description` override below anymore: action.input
        // already carries the user's own text, or nothing.
        await updateEventAsync({
          id: action.eventId,
          ...action.input,
          title: undefined,
        });
        toast.success("Meeting moved", {
          description: `Attendees have been notified`,
        });
      } else {
        const event = await createEventAsync({
          ...action.input,
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

  /**
   * A guest asking the organiser for a different time.
   *
   * This is a mail, not an API call, and that is not a shortcut: the Google
   * Calendar API has no propose-new-time field — an attendee may set only
   * `responseStatus` and a free-text `comment`. Google's own feature is an
   * email (an iCalendar COUNTER) underneath. Replying on the thread the
   * meeting already came from is the version of that which creates no second
   * conversation.
   *
   * Opens a normal reply, seeded and fully editable. Deliberately not sent
   * automatically — proposing a time is a message to a person, and the words
   * are the user's to choose.
   */
  const handleProposeNewTime = (meeting: ThreadMeeting) => {
    const when = formatMeetingWindow(meeting.start, meeting.end);
    setBox({
      mode: "reply",
      seedBody:
        `Would it be possible to move "${meeting.title}"?\n\n` +
        `It's currently set for ${when}. ` +
        `A different time would work better for me — happy to fit around you.\n\n`,
    });
  };

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
          title={upcomingMeeting ? "Move this thread's meeting" : "Schedule Meeting"}
        >
          <CalendarIcon className={cn("size-4", isScheduling ? "text-primary" : "text-muted-foreground")} />
          {/* Without the dot this icon looks identical whether the thread has
              a meeting or not, so there was no reason to ever click it. */}
          {/* The dot means "there is a meeting to act on here". A finished one
              is history and gets no dot — it would send the user to a form
              that can only create a new meeting anyway. */}
          {upcomingMeetings.length > 0 && (
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

      <div className="space-y-6">
        {/* The thread's meeting, if it has one. Rendered before the summary so
            "this mail has a meeting attached" is the first thing seen — the
            link existed for a while before anything displayed it, which meant
            the only way to discover a meeting was to click an unlabelled
            calendar icon and hope. */}
        {(threadMeetings.length > 0 || deletedLink) && (
          <div className="space-y-3">
            {/* Its own card, above the live ones. A vanished meeting is a
                warning, not a meeting, and folding it into the list would put
                a red banner in a row of things the user can still act on. */}
            {deletedLink && (
              <ThreadMeetingCard
                deletedLink={deletedLink}
                onAcknowledgeDeleted={(eventId) => void acknowledgeAsync({ eventId })}
              />
            )}

            {/* EVERY meeting, not just the newest.

                A thread genuinely holds more than one: the assistant's
                precheck offers "keep it and add a SECOND, separate meeting",
                and `resolveWriteTarget` has a whole `ambiguous` branch for it.
                Rendering `meetings[0]` alone meant the second meeting — the
                one the user had just been asked about and agreed to — existed
                in the database, in Google, and in Dobbie's answers, while the
                thread page showed no sign of it. Implemented, and not Visible.

                Each card carries its own verbs, because with two meetings
                "reschedule it" has no referent: the card the button sits on is
                what says which meeting is meant. */}
            {orderedMeetings.map((m) => (
              <ThreadMeetingCard
                key={m.eventId}
                meeting={m}
                isGuest={m.role === "GUEST"}
                isPast={!isUpcomingMeeting(m)}
                busy={submittingMeeting || cancellingEventId === m.eventId}
                onReschedule={() => startReschedule(m)}
                onCancel={() => void handleCancelMeeting(m)}
                onScheduleNew={startNewMeeting}
                onProposeNewTime={() => handleProposeNewTime(m)}
              />
            ))}
          </div>
        )}

        {/* Directly under the cards, so pressing Reschedule opens the form
            below the meeting it acts on rather than somewhere above the
            button, off the user's eyeline. With more than one meeting the
            form is no longer adjacent to the card that opened it, which is
            why it names its target: `existing={movingMeeting}` renders the
            "moving this meeting" banner from the form's own target.

            The fields are the compose invite component, not a second
            implementation of it. The thread's own copy is how this form ended
            up with no AM/PM, no location, and no mention of the meeting it was
            about to move; sharing the component means the two cannot drift
            apart again. `deletedLink` is deliberately not passed — that warning
            belongs to ThreadMeetingCard above, and passing it here would render
            it twice. */}
        {isScheduling && (
          <form
            ref={scheduleFormRef}
            onSubmit={handleConfirmMeeting}
            className="p-4 rounded-xl border bg-card space-y-3"
          >
            {/* Hidden when moving: the update path deliberately doesn't send a
                title, so an editable one here would be a lie about what the
                form does — and the value it would carry is the reply's
                "Re: …" subject. */}
            {!isMovingMeeting && (
              <div className="space-y-1">
                <label className="text-[9px] text-muted-foreground uppercase font-mono">
                  Title
                </label>
                <Input
                  type="text"
                  value={meetingTitle}
                  onChange={(e) => setMeetingTitle(e.target.value)}
                  className="h-8 text-xs font-serif bg-transparent"
                  required
                />
              </div>
            )}

            <MeetingInviteFields
              value={meetingState}
              onChange={setMeetingState}
              existing={movingMeeting}
              disabled={submittingMeeting}
              density="compact"
              showToggle={false}
              heading={isMovingMeeting ? "Reschedule this meeting" : "Schedule a meeting"}
            />

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
              <Button
                size="sm"
                type="submit"
                disabled={submittingMeeting}
                className="h-7 text-[10px] font-mono uppercase"
              >
                {submittingMeeting ? "Saving..." : isMovingMeeting ? "Move" : "Confirm"}
              </Button>
            </div>
          </form>
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

        {/* Served from the local copy because Gmail was unreachable — say so
            rather than passing stale content off as live. */}
        {thread.source === "cache" && (
          <StaleThreadBanner
            cachedAt={thread.cachedAt}
            retryAfter={thread.retryAfter}
            staleReason={thread.staleReason}
            onRetry={() => void refetchThread()}
            isRefetching={isFetchingThread}
          />
        )}

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
            initialBody={box.draftId ? activeDraft?.body : box.seedBody}
            onClose={closeBox}
            onSent={() => void refetchThread()}
          />
        )}
      </div>
    </div>
  );
}
