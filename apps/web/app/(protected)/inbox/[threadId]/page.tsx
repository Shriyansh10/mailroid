"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useThread } from "@web/hooks/api/gmail";
import { useCreateEvent } from "@web/hooks/api/calendar";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardContent } from "@web/components/ui/card";
import { Button } from "@web/components/ui/button";
import { Badge } from "@web/components/ui/badge";
import { Skeleton } from "@web/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@web/components/ui/alert";
import { Input } from "@web/components/ui/input";
import {
  ArrowLeft as ArrowLeftIcon,
  Sparkles as SparklesIcon,
  Reply as ReplyIcon,
  ReplyAll as ReplyAllIcon,
  Forward as ForwardIcon,
  Calendar as CalendarIcon,
  AlertCircle as AlertCircleIcon
} from "lucide-react";
import { cn } from "@web/lib/utils";
import { EmailSummaryCard } from "@web/components/email-summary-card";
import { ThreadMessageList } from "@web/components/thread-message-list";

export default function ThreadDetailPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const { data: thread, isLoading, isError, error } = useThread(threadId);
  const router = useRouter();

  const [isScheduling, setIsScheduling] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [meetingTime, setMeetingTime] = useState("");
  const [meetingDuration, setMeetingDuration] = useState("60");
  const [submittingMeeting, setSubmittingMeeting] = useState(false);

  const firstMsg = thread?.messages?.[0];
  const senderEmail = useMemo(() => {
    if (!firstMsg?.from) return "";
    const match = firstMsg.from.match(/<([^>]+)>/);
    return match ? match[1] : firstMsg.from;
  }, [firstMsg]);

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
        description: `Scheduled from Mailroid Dossier: ${thread?.subject || ""}\nSender: ${firstMsg?.from}`,
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

  const handleReply = () => {
    if (!thread || !firstMsg) return;
    window.dispatchEvent(
      new CustomEvent("mailroid-compose-email", {
        detail: {
          to: senderEmail,
          subject: thread.subject ? `Re: ${thread.subject}` : "Reply",
          body: `\n\n--- On Original Thread ---\nFrom: ${firstMsg.from}\nSubject: ${thread.subject}`,
          threadId: thread.threadId
        },
      })
    );
    toast.success("Draft Created", { description: `Replying to ${senderEmail}` });
  };

  const handleReplyAll = () => {
    if (!thread || !firstMsg) return;
    const recipientsList = [senderEmail];
    if (firstMsg.to) {
      const matchTo = firstMsg.to.match(/<([^>]+)>/);
      const toEmail = matchTo ? matchTo[1] : firstMsg.to;
      if (toEmail !== senderEmail) recipientsList.push(toEmail);
    }
    const recipients = recipientsList.join(", ");

    window.dispatchEvent(
      new CustomEvent("mailroid-compose-email", {
        detail: {
          to: recipients,
          subject: thread.subject ? `Re: ${thread.subject}` : "Reply All",
          body: `\n\n--- On Original Thread ---\nFrom: ${firstMsg.from}\nTo: ${firstMsg.to}\nSubject: ${thread.subject}`,
          threadId: thread.threadId
        },
      })
    );
    toast.success("Draft Created", { description: `Replying all to ${recipients}` });
  };

  const handleForward = () => {
    if (!thread || !firstMsg) return;
    window.dispatchEvent(
      new CustomEvent("mailroid-compose-email", {
        detail: {
          to: "",
          subject: thread.subject ? `Fwd: ${thread.subject}` : "Forward",
          body: `\n\n---------- Forwarded message ---------\nFrom: ${firstMsg.from}\nDate: ${firstMsg.date}\nSubject: ${thread.subject}\nTo: ${firstMsg.to}\n\n${firstMsg.body || firstMsg.snippet}`,
          threadId: thread.threadId
        },
      })
    );
    toast.success("Draft Created", { description: "Forwarding message" });
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
      <div className="space-y-2 mb-6 pb-4 border-b">
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

      {/* Grid Layout (Main Area vs Sidebar) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Main Content Pane */}
        <div className="lg:col-span-9 space-y-6">
          
          {/* On-demand AI summary. Previously this card rendered
              priorityReason (a classification rationale) or, failing that,
              the raw Gmail snippet — neither of which was a summary, and
              the snippet leaked whatever the email happened to contain. */}
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
        </div>

        {/* Sidebar Actions Column */}
        <div className="lg:col-span-3">
          <div className="sticky top-4 space-y-4">
            <div className="bg-card border rounded-xl p-4 shadow-sm space-y-3">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/80 font-bold mb-2 select-none">
                Correspondence Tools
              </div>
              
              <Button 
                variant="outline" 
                className="w-full justify-start gap-2.5 font-mono text-xs uppercase h-9 hover:border-[#b08d57]/30 hover:bg-[#b08d57]/5 cursor-pointer text-left truncate"
                onClick={handleReply}
              >
                <ReplyIcon className="size-3.5 text-[#b08d57] shrink-0" />
                <span className="truncate">Reply</span>
              </Button>
              
              <Button 
                variant="outline" 
                className="w-full justify-start gap-2.5 font-mono text-xs uppercase h-9 hover:border-[#b08d57]/30 hover:bg-[#b08d57]/5 cursor-pointer text-left truncate"
                onClick={handleReplyAll}
              >
                <ReplyAllIcon className="size-3.5 text-[#b08d57] shrink-0" />
                <span className="truncate">Reply All</span>
              </Button>
              
              <Button 
                variant="outline" 
                className="w-full justify-start gap-2.5 font-mono text-xs uppercase h-9 hover:border-[#b08d57]/30 hover:bg-[#b08d57]/5 cursor-pointer text-left truncate"
                onClick={handleForward}
              >
                <ForwardIcon className="size-3.5 text-[#b08d57] shrink-0" />
                <span className="truncate">Forward</span>
              </Button>

              <div className="border-t border-border my-2" />

              {/* Schedule Meeting form / button */}
              {isScheduling ? (
                <form onSubmit={handleConfirmMeeting} className="space-y-3 pt-2">
                  <div className="text-[9px] font-mono uppercase tracking-wider text-[#b08d57] font-bold">
                    Calendar Dispatch
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
                    <Button
                      size="sm"
                      type="submit"
                      disabled={submittingMeeting}
                      className="h-7 text-[10px] font-mono uppercase bg-[#b08d57] text-black hover:bg-[#8c6f37] hover:text-white"
                    >
                      {submittingMeeting ? "Saving..." : "Confirm"}
                    </Button>
                  </div>
                </form>
              ) : (
                <Button 
                  variant="outline" 
                  className="w-full justify-start gap-2.5 font-mono text-xs uppercase h-9 hover:border-[#b08d57]/30 hover:bg-[#b08d57]/5 cursor-pointer text-left truncate"
                  onClick={() => setIsScheduling(true)}
                >
                  <CalendarIcon className="size-4 text-[#b08d57] shrink-0" />
                  <span className="truncate">Schedule Meeting</span>
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
