"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  useThread,
  useTrashThread,
  useSetStarred,
  useDraft,
} from "@web/hooks/api/gmail";
import { useCreateEvent } from "@web/hooks/api/calendar";
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

  const [isScheduling, setIsScheduling] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [meetingTime, setMeetingTime] = useState("");
  const [meetingDuration, setMeetingDuration] = useState("60");
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

  const senderEmail = useMemo(() => {
    if (!lastMsg?.from) return "";
    const match = lastMsg.from.match(/<([^>]+)>/);
    return match ? match[1] : lastMsg.from;
  }, [lastMsg]);

  const replyAllRecipients = useMemo(() => {
    if (!lastMsg) return "";
    const recipients = [senderEmail];
    if (lastMsg.to) {
      const matchTo = lastMsg.to.match(/<([^>]+)>/);
      const toEmail = matchTo ? matchTo[1] : lastMsg.to;
      if (toEmail && toEmail !== senderEmail) recipients.push(toEmail);
    }
    return recipients.filter(Boolean).join(", ");
  }, [lastMsg, senderEmail]);

  useEffect(() => {
    if (thread) {
      setMeetingTitle(`Discussion: ${thread.subject || "Untitled"}`);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      setMeetingDate(tomorrow.toISOString().split("T")[0] || "");
      setMeetingTime("10:00");
      setIsScheduling(false);
    }
  }, [thread]);

  const { createEventAsync } = useCreateEvent();

  const handleConfirmMeeting = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingMeeting(true);
    try {
      const startDateTime = new Date(`${meetingDate}T${meetingTime}`);
      const endDateTime = new Date(startDateTime.getTime() + parseInt(meetingDuration, 10) * 60 * 1000);

      await createEventAsync({
        title: meetingTitle,
        start: startDateTime.toISOString(),
        end: endDateTime.toISOString(),
        description: `Scheduled from Mailroid Dossier: ${thread?.subject || ""}\nSender: ${lastMsg?.from}`,
        attendees: senderEmail ? [senderEmail] : [],
      });

      toast.success("Meeting Scheduled", {
        description: `Successfully scheduled with ${senderEmail}`,
      });
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
  const { data: resumedDraft } = useDraft(resumeDraftId);
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
      // Strip ?draftId= so a refresh doesn't reopen an already-handled draft.
      router.replace(`/inbox/${threadId}`);
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
        <Button onClick={() => router.push("/inbox")} variant="outline">
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
        <Button onClick={() => router.push("/inbox")} variant="outline">
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

  // The draft's own fields, whichever source has them: the `?draftId=` fetch
  // (resumedDraft) when opened from the Draft list, or the thread's own
  // trailing draft message when detected in-place — either way the box
  // prefills from the same draftId it's editing, never mismatched.
  const activeDraft = box?.draftId
    ? box.draftId === resumedDraft?.draftId
      ? resumedDraft
      : box.draftId === trailingDraft?.draftId
        ? trailingDraft
        : undefined
    : undefined;

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
          href="/inbox"
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
          className="size-8"
          onClick={() => setIsScheduling((s) => !s)}
          title="Schedule Meeting"
        >
          <CalendarIcon className={cn("size-4", isScheduling ? "text-primary" : "text-muted-foreground")} />
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
            Schedule a meeting
          </div>
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
                value={meetingDate}
                onChange={(e) => setMeetingDate(e.target.value)}
                className="h-8 text-xs font-mono px-2 bg-transparent"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-[9px] text-muted-foreground uppercase font-mono">Time</label>
              <Input
                type="time"
                value={meetingTime}
                onChange={(e) => setMeetingTime(e.target.value)}
                className="h-8 text-xs font-mono px-2 bg-transparent"
                required
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[9px] text-muted-foreground uppercase font-mono">Duration</label>
            <select
              value={meetingDuration}
              onChange={(e) => setMeetingDuration(e.target.value)}
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
              {submittingMeeting ? "Saving..." : "Confirm"}
            </Button>
          </div>
        </form>
      )}

      <div className="space-y-6">
        {/* On-demand AI summary. Previously this card rendered priorityReason
            (a classification rationale) or, failing that, the raw Gmail
            snippet — neither of which was a summary, and the snippet leaked
            whatever the email happened to contain. */}
        <EmailSummaryCard
          entityId={thread.messages[0]?.id}
          threadId={thread.threadId}
          subject={thread.subject}
          sender={thread.messages[0]?.from}
          receivedAt={thread.messages[0]?.date}
          initialSummary={thread.summary}
          initialDigest={thread.summaryDigest}
          initialFullText={thread.summaryFullText}
          initialFlags={thread.summaryFlags}
        />

        {/* Email Messages Timeline */}
        <ThreadMessageList messages={thread.messages} />

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
            displayTo={
              box.draftId
                ? undefined
                : box.mode === "replyAll"
                  ? replyAllRecipients
                  : box.mode === "reply"
                    ? senderEmail
                    : undefined
            }
            draftId={box.draftId}
            subject={boxSubject}
            initialTo={box.draftId ? activeDraft?.to : undefined}
            initialBody={box.draftId ? activeDraft?.body : undefined}
            onClose={closeBox}
            onSent={() => void refetchThread()}
          />
        )}
      </div>
    </div>
  );
}
