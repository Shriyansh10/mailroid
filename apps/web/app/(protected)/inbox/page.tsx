"use client";

import React, { useEffect, useState, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { 
  useCategoryEmails, 
  useSearchLocalEmails, 
  useSearchEmails, 
  usePriorityEmails, 
  usePriorityCounts,
  useThread
} from "@web/hooks/api/gmail";
import { useCalendarEvents, useCreateEvent } from "@web/hooks/api/calendar";
import { Button } from "@web/components/ui/button";
import { Spinner } from "@web/components/ui/spinner";
import { 
  ChevronLeftIcon, 
  ChevronRightIcon, 
  SearchIcon, 
  SparklesIcon, 
  CalendarDaysIcon, 
  SendIcon, 
  InboxIcon, 
  ArrowUpRightIcon,
  ArchiveIcon
} from "lucide-react";
import { cn } from "@web/lib/utils";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";

const CATEGORIES = [
  { key: "PRIMARY", label: "Primary" },
  { key: "PROMOTIONS", label: "Promotions" },
  { key: "SOCIAL", label: "Social" },
  { key: "FORUMS", label: "Forums" },
] as const;

const PAGE_SIZE = 50;

function formatThreadDate(dateString: string): string {
  if (!dateString) return "";
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const oneYearMs = 365.25 * oneDayMs;

  if (diffMs < oneDayMs && diffMs >= 0) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } else if (diffMs < oneYearMs) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } else {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
}

// ── Priority Wax Seals ───────────────────────────────────────────────

function PrioritySeal({ priority, score }: { priority?: string; score?: number | null }) {
  const p = priority || "MEDIUM";
  const s = score !== null && score !== undefined ? score : 0.5;
  
  let details = {
    label: "Moonlight",
    classes: "bg-[#0b0c10] border border-[#2c3545]/40 text-[#8f9eb3] shadow-[0_1px_4px_rgba(44,53,69,0.15)]"
  };

  if (p === "HIGH") {
    if (s >= 0.85) {
      details = {
        label: "Blood Seal",
        classes: "bg-[#2d0709] border border-[#6b1618]/50 text-[#ff9e9e] shadow-[0_2px_8px_rgba(107,22,24,0.3)] animate-pulse"
      };
    } else {
      details = {
        label: "Brass Seal",
        classes: "bg-[#241c0e] border border-[#5c4a25]/50 text-[#d4af37] shadow-[0_2px_6px_rgba(92,74,37,0.2)]"
      };
    }
  } else if (p === "LOW") {
    details = {
      label: "Parchment",
      classes: "bg-[#0e0e0d] border border-[#2b2721]/30 text-[#615a4e]"
    };
  }

  return (
    <div className={cn(
      "text-[8px] font-mono tracking-widest uppercase font-bold px-2 py-0.5 rounded-md text-center flex items-center justify-center shrink-0 min-w-[75px] h-4.5",
      details.classes
    )}>
      {details.label}
    </div>
  );
}

// ── Visual Illustrations ─────────────────────────────────────────────

function ArchiveIllustration() {
  return (
    <svg
      viewBox="0 0 200 200"
      className="w-20 h-20 text-[#b08d57]/20 mb-3 mx-auto stroke-current"
      fill="none"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="50" y="70" width="100" height="80" rx="3" />
      <line x1="50" y1="110" x2="150" y2="110" />
      <line x1="95" y1="90" x2="105" y2="90" strokeWidth="2" />
      <line x1="95" y1="130" x2="105" y2="130" strokeWidth="2" />
      <path d="M75 70V54a2 2 0 0 1 2-2h46a2 2 0 0 1 2 2v16" />
    </svg>
  );
}

function CalendarIllustration() {
  return (
    <svg
      viewBox="0 0 100 100"
      className="w-12 h-12 text-[#b08d57]/25 my-1 mx-auto stroke-current"
      fill="none"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="25" y="25" width="50" height="50" rx="2" />
      <line x1="25" y1="42" x2="75" y2="42" />
      <line x1="40" y1="20" x2="40" y2="30" />
      <line x1="60" y1="20" x2="60" y2="30" />
      <circle cx="50" cy="56" r="2.5" className="fill-[#b08d57]/20" />
    </svg>
  );
}

// ── Executive Briefing Strip ─────────────────────────────────────────

function ExecutiveBriefing({ 
  threads,
  meetingsCount
}: { 
  threads: Array<any>;
  meetingsCount: number;
}) {
  const requiresAction = useMemo(() => threads.filter(t => t.isActionRequired).length, [threads]);
  const priorityCount = useMemo(() => threads.filter(t => t.priority === "HIGH").length, [threads]);
  const waitingForResponse = useMemo(() => {
    // Dynamically calculate waiting count (emails not unread and not action required)
    return Math.max(1, threads.filter(t => !t.isUnread && t.priority === "MEDIUM").length);
  }, [threads]);
  
  const focusThread = useMemo(() => {
    return threads.find(t => t.priority === "HIGH" && t.isActionRequired) || threads.find(t => t.priority === "HIGH") || threads[0];
  }, [threads]);

  return (
    <div className="border border-[#b08d57]/20 bg-[#b08d57]/3 rounded-lg p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-4 max-h-[120px] overflow-hidden select-none font-mono">
      {/* Recommended Focus Section */}
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="text-[9px] uppercase tracking-widest text-[#b08d57] font-bold">
          Today's Intelligence
        </span>
        <div className="text-xs text-[#D9D1C1]/90 truncate font-serif mt-1">
          <span className="font-mono text-[9px] text-[#b08d57]/60 uppercase tracking-wider mr-1.5">Recommended Focus:</span>
          {focusThread ? focusThread.subject : "Webhook Verification Review"}
        </div>
      </div>

      {/* Stats Summary Grid */}
      <div className="flex items-center gap-5 shrink-0 text-center">
        <div className="flex flex-col min-w-[55px]">
          <span className="text-sm font-bold text-[#D9D1C1] font-sans">{requiresAction}</span>
          <span className="text-[7.5px] text-[#D9D1C1]/40 uppercase tracking-wider mt-0.5">Requires Action</span>
        </div>
        <div className="h-6 w-px bg-[#b08d57]/15" />
        <div className="flex flex-col min-w-[55px]">
          <span className="text-sm font-bold text-[#D9D1C1] font-sans">{waitingForResponse}</span>
          <span className="text-[7.5px] text-[#D9D1C1]/40 uppercase tracking-wider mt-0.5">Waiting Response</span>
        </div>
        <div className="h-6 w-px bg-[#b08d57]/15" />
        <div className="flex flex-col min-w-[55px]">
          <span className="text-sm font-bold text-[#D9D1C1] font-sans">{meetingsCount}</span>
          <span className="text-[7.5px] text-[#D9D1C1]/40 uppercase tracking-wider mt-0.5">Upcoming Meetings</span>
        </div>
        <div className="h-6 w-px bg-[#b08d57]/15" />
        <div className="flex flex-col min-w-[55px]">
          <span className="text-sm font-bold text-[#D9D1C1] font-sans">{priorityCount}</span>
          <span className="text-[7.5px] text-[#D9D1C1]/40 uppercase tracking-wider mt-0.5">Priority Threads</span>
        </div>
      </div>
    </div>
  );
}

// ── Context Rail ─────────────────────────────────────────────────────

function ContextRail({ 
  thread, 
  threads,
  onArchiveThread,
  onBackToList
}: { 
  thread: any; 
  threads: Array<any>;
  onArchiveThread: (id: string) => void;
  onBackToList?: () => void;
}) {
  const { createEventAsync } = useCreateEvent();
  
  const [scheduling, setScheduling] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [meetingTime, setMeetingTime] = useState("");
  const [meetingDuration, setMeetingDuration] = useState("60");
  const [submittingMeeting, setSubmittingMeeting] = useState(false);

  useEffect(() => {
    if (thread) {
      setMeetingTitle(`Discussion: ${thread.subject || "Untitled"}`);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      setMeetingDate(tomorrow.toISOString().split("T")[0] || "");
      setMeetingTime("10:00");
      setScheduling(false);
    }
  }, [thread]);

  const senderEmail = useMemo(() => {
    if (!thread?.sender) return "";
    const match = thread.sender.match(/<([^>]+)>/);
    return match ? match[1] : thread.sender;
  }, [thread?.sender]);

  // Fetch upcoming calendar events for matching (next 14 days)
  const now = useMemo(() => new Date(), [thread]);
  const oneDayAgo = useMemo(() => new Date(now.getTime() - 24 * 60 * 60 * 1000), [now]);
  const fourteenDaysLater = useMemo(() => new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000), [now]);

  const { data: calendarEvents } = useCalendarEvents(
    oneDayAgo.toISOString(),
    fourteenDaysLater.toISOString()
  );

  const relatedMeetings = useMemo(() => {
    if (!thread || !calendarEvents) return [];
    const subject = (thread.subject || "").toLowerCase();
    
    return calendarEvents.filter((event) => {
      const emailMatch = event.attendees?.some((email: string) => 
        email.toLowerCase() === senderEmail.toLowerCase()
      );
      const titleMatch = event.title && event.title.toLowerCase().includes(subject) ||
        (subject.length > 4 && event.title && subject.includes(event.title.toLowerCase()));
      const descMatch = event.description && event.description.toLowerCase().includes(subject);
      
      return emailMatch || titleMatch || descMatch;
    });
  }, [thread, calendarEvents, senderEmail]);

  // Related correspondence - filters loaded emails for sender matches
  const relatedCorrespondence = useMemo(() => {
    if (!thread || !threads) return [];
    return threads.filter(t => 
      t.threadId !== thread.threadId && 
      (t.sender.toLowerCase().includes(senderEmail.toLowerCase()) || 
       (thread.subject && t.subject && t.subject.toLowerCase().includes(thread.subject.toLowerCase().slice(0, 10))))
    ).slice(0, 3);
  }, [thread, threads, senderEmail]);

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
        description: `Scheduled from Mailroid Dossier: ${thread.subject || ""}\nSender: ${thread.sender}`,
        attendees: senderEmail ? [senderEmail] : [],
      });
      
      toast.success("Meeting Scheduled", {
        description: `Successfully scheduled with ${senderEmail}`,
      });
      setScheduling(false);
    } catch (err: any) {
      console.error(err);
      toast.error("Failed to schedule meeting", {
        description: err.message || "An unknown error occurred",
      });
    } finally {
      setSubmittingMeeting(false);
    }
  };

  if (!thread) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center py-24 text-[#D9D1C1]/20">
        <ArchiveIllustration />
        <p className="text-[10px] font-mono uppercase tracking-widest">Select correspondence</p>
      </div>
    );
  }

  return (
    <motion.div 
      key={thread.threadId}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
      className="flex flex-col gap-6 h-full py-2"
    >
      {onBackToList && (
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={onBackToList} 
          className="lg:hidden text-[#b08d57] hover:text-[#b08d57]/80 self-start p-0 mb-2 font-mono text-xs uppercase"
        >
          ← Back to Dossiers
        </Button>
      )}

      {/* Header Info */}
      <div className="border-b border-[#b08d57]/15 pb-4">
        <h2 className="font-serif text-lg font-semibold text-[#D9D1C1] leading-tight mt-2 mb-1.5">
          {thread.subject || "(No Subject)"}
        </h2>
        <p className="text-[10px] font-mono text-[#D9D1C1]/60 truncate">
          Sender: {thread.sender}
        </p>
      </div>

      {/* AI Summary ("Why Important") */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[10px] font-mono uppercase tracking-wider text-[#b08d57]">
          Why Important
        </h3>
        <div className="bg-[#b08d57]/5 border border-[#b08d57]/10 rounded-lg p-4 font-serif text-sm text-[#D9D1C1]/90 leading-relaxed relative overflow-hidden">
          <div className="absolute right-2 top-2 select-none opacity-20">
            <SparklesIcon className="size-3.5 text-[#b08d57]" />
          </div>
          <span className="block text-[8.5px] font-mono uppercase tracking-wider text-[#b08d57]/50 mb-1.5 select-none">
            Intelligence Classification
          </span>
          {thread.priorityReason ? (
            <p>&ldquo;{thread.priorityReason}&rdquo;</p>
          ) : (
            <p className="italic text-[#D9D1C1]/50">
              No priority triage explanation stored. This message contains standard correspondence.
            </p>
          )}
        </div>
      </div>

      {/* Related Meetings */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[10px] font-mono uppercase tracking-wider text-[#b08d57]">
          Related Meetings
        </h3>
        {relatedMeetings.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-4 bg-white/[0.01] border border-white/[0.03] rounded-lg">
            <CalendarIllustration />
            <span className="text-[9px] font-mono text-[#D9D1C1]/40 uppercase tracking-wider">No related meetings found.</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {relatedMeetings.map((event) => (
              <div 
                key={event.id} 
                className="bg-white/[0.01] border border-white/[0.04] hover:border-[#b08d57]/20 rounded-lg p-3 flex flex-col gap-1 transition-colors"
              >
                <span className="text-xs font-serif font-bold text-[#D9D1C1]">
                  {event.title}
                </span>
                <div className="flex items-center justify-between text-[9px] font-mono text-[#D9D1C1]/50 mt-1">
                  <span>
                    {new Date(event.start).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                  <span>
                    {new Date(event.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Related Correspondence */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[10px] font-mono uppercase tracking-wider text-[#b08d57]">
          Recent Related Correspondence
        </h3>
        {relatedCorrespondence.length === 0 ? (
          <div className="text-[9px] font-mono text-[#D9D1C1]/30 bg-white/[0.01] border border-white/[0.03] rounded-lg p-3 italic">
            No related entries on file.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {relatedCorrespondence.map((rel) => (
              <div 
                key={rel.threadId}
                className="bg-white/[0.01] border border-white/[0.04] rounded-lg p-2.5 flex flex-col gap-0.5 cursor-pointer hover:border-[#b08d57]/20"
                onClick={() => window.location.href = `/inbox/${rel.threadId}`}
              >
                <span className="text-[11px] font-serif font-bold text-[#D9D1C1] truncate">{rel.subject}</span>
                <span className="text-[8.5px] font-mono text-[#D9D1C1]/50 truncate">{formatThreadDate(rel.date)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Suggested Actions */}
      <div className="flex flex-col gap-2 mt-auto">
        <h3 className="text-[10px] font-mono uppercase tracking-wider text-[#b08d57] mb-1">
          Suggested Action
        </h3>
        <div className="flex flex-col gap-2">
          {/* Reply */}
          <Button
            variant="outline"
            className="w-full justify-start text-left border-white/10 hover:border-[#b08d57]/30 hover:bg-[#b08d57]/5 text-[#D9D1C1] gap-2.5 font-mono text-xs uppercase tracking-wider py-4 cursor-pointer"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("mailroid-compose-email", {
                  detail: {
                    to: senderEmail,
                    subject: thread.subject ? `Re: ${thread.subject}` : "Reply",
                    body: `\n\n--- On Original Thread ---\nFrom: ${thread.sender}\nSubject: ${thread.subject}\nSnippet: ${thread.snippet}`,
                  },
                })
              );
            }}
          >
            <SendIcon className="size-3.5 rotate-[-45deg] text-[#b08d57]" />
            Reply to Sender
          </Button>

          {/* Schedule Meeting Form */}
          {scheduling ? (
            <motion.form 
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              onSubmit={handleConfirmMeeting} 
              className="bg-white/[0.01] border border-[#b08d57]/15 rounded-lg p-4 flex flex-col gap-3"
            >
              <span className="text-[9px] font-mono uppercase tracking-wider text-[#b08d57] font-bold">
                Direct Scheduler
              </span>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-[#D9D1C1]/50 uppercase font-mono">Title</label>
                <input
                  type="text"
                  value={meetingTitle}
                  onChange={(e) => setMeetingTitle(e.target.value)}
                  className="bg-black/40 border border-white/10 focus:border-[#b08d57] rounded px-2.5 py-1.5 text-xs text-[#D9D1C1] outline-none transition-colors font-serif"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] text-[#D9D1C1]/50 uppercase font-mono">Date</label>
                  <input
                    type="date"
                    value={meetingDate}
                    onChange={(e) => setMeetingDate(e.target.value)}
                    className="bg-black/40 border border-white/10 focus:border-[#b08d57] rounded px-2 py-1.5 text-xs text-[#D9D1C1] outline-none transition-colors font-mono"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[9px] text-[#D9D1C1]/50 uppercase font-mono">Time</label>
                  <input
                    type="time"
                    value={meetingTime}
                    onChange={(e) => setMeetingTime(e.target.value)}
                    className="bg-black/40 border border-white/10 focus:border-[#b08d57] rounded px-2 py-1.5 text-xs text-[#D9D1C1] outline-none transition-colors font-mono"
                    required
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[9px] text-[#D9D1C1]/50 uppercase font-mono">Duration</label>
                <select
                  value={meetingDuration}
                  onChange={(e) => setMeetingDuration(e.target.value)}
                  className="bg-black/40 border border-white/10 focus:border-[#b08d57] rounded px-2 py-1.5 text-xs text-[#D9D1C1] outline-none transition-colors font-mono"
                >
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="90">1.5 hours</option>
                  <option value="120">2 hours</option>
                </select>
              </div>
              <div className="flex gap-2 justify-end mt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  className="text-[9px] font-mono uppercase border border-white/5 hover:bg-white/5 text-[#D9D1C1] h-7 px-2.5"
                  onClick={() => setScheduling(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  type="submit"
                  disabled={submittingMeeting}
                  className="text-[9px] font-mono uppercase bg-[#b08d57] text-black hover:bg-[#8c6f37] hover:text-white h-7 px-3"
                >
                  {submittingMeeting ? "Scheduling..." : "Confirm"}
                </Button>
              </div>
            </motion.form>
          ) : (
            <Button
              variant="outline"
              className="w-full justify-start text-left border-white/10 hover:border-[#b08d57]/30 hover:bg-[#b08d57]/5 text-[#D9D1C1] gap-2.5 font-mono text-xs uppercase tracking-wider py-4 cursor-pointer"
              onClick={() => setScheduling(true)}
            >
              <CalendarDaysIcon className="size-3.5 text-[#b08d57]" />
              Schedule Meeting
            </Button>
          )}

          {/* Archive */}
          <Button
            variant="outline"
            className="w-full justify-start text-left border-white/10 hover:border-red-950/30 hover:bg-red-950/10 text-[#D9D1C1] gap-2.5 font-mono text-xs uppercase tracking-wider py-4 cursor-pointer"
            onClick={() => onArchiveThread(thread.threadId)}
          >
            <InboxIcon className="size-3.5 text-[#b08d57]" />
            Archive Dossier
          </Button>

          {/* Open Thread callback */}
          <Button
            variant="ghost"
            className="w-full justify-start text-left text-[#b08d57]/70 hover:text-[#b08d57] hover:bg-transparent gap-2.5 font-mono text-xs uppercase tracking-wider py-2 px-1 mt-1 cursor-pointer"
            onClick={() => {
              window.location.href = `/inbox/${thread.threadId}`;
            }}
          >
            <ArrowUpRightIcon className="size-3.5" />
            Open Full Discussion
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

// ── Dossier List Layout ──────────────────────────────────────────────

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.03
    }
  }
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 100, damping: 15 } }
};

function DossierLayout({
  title,
  subtitle,
  threads,
  isLoading,
  isError,
  error,
  headerActions,
  pagination,
}: {
  title: string;
  subtitle: string;
  threads: Array<any>;
  isLoading: boolean;
  isError: boolean;
  error: any;
  headerActions?: React.ReactNode;
  pagination?: React.ReactNode;
}) {
  const router = useRouter();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [archivedIds, setArchivedIds] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");

  const visibleThreads = useMemo(() => {
    return threads.filter((t) => !archivedIds.includes(t.threadId));
  }, [threads, archivedIds]);

  const activeThread = useMemo(() => {
    return visibleThreads.find((t) => t.threadId === selectedThreadId);
  }, [visibleThreads, selectedThreadId]);

  // Sync calendar events count for executive briefing
  const startOfToday = useMemo(() => {
    const d = new Date();
    d.setHours(0,0,0,0);
    return d.toISOString();
  }, []);
  const endOfToday = useMemo(() => {
    const d = new Date();
    d.setHours(23,59,59,999);
    return d.toISOString();
  }, []);
  const { data: todayMeetings } = useCalendarEvents(startOfToday, endOfToday);
  const meetingsCount = todayMeetings?.length ?? 0;

  // Handle auto-selecting the first thread
  useEffect(() => {
    if (visibleThreads.length > 0) {
      if (!selectedThreadId) {
        setSelectedThreadId(visibleThreads[0].threadId);
        setActiveIndex(0);
      } else {
        const idx = visibleThreads.findIndex((t) => t.threadId === selectedThreadId);
        if (idx === -1) {
          setSelectedThreadId(visibleThreads[0].threadId);
          setActiveIndex(0);
        } else {
          setActiveIndex(idx);
        }
      }
    } else {
      setSelectedThreadId(null);
      setActiveIndex(null);
    }
  }, [visibleThreads, selectedThreadId]);

  // Keyboard navigation support
  useEffect(() => {
    const handleNext = () => {
      setActiveIndex((prev) => {
        if (prev === null) return 0;
        if (prev >= visibleThreads.length - 1) return prev;
        return prev + 1;
      });
    };

    const handlePrev = () => {
      setActiveIndex((prev) => {
        if (prev === null || prev === 0) return 0;
        return prev - 1;
      });
    };

    const handleOpen = () => {
      if (activeIndex !== null && visibleThreads[activeIndex]) {
        router.push(`/inbox/${visibleThreads[activeIndex].threadId}`);
      }
    };

    window.addEventListener("mailroid-select-next", handleNext);
    window.addEventListener("mailroid-select-prev", handlePrev);
    window.addEventListener("mailroid-open-selected", handleOpen);

    return () => {
      window.removeEventListener("mailroid-select-next", handleNext);
      window.removeEventListener("mailroid-select-prev", handlePrev);
      window.removeEventListener("mailroid-open-selected", handleOpen);
    };
  }, [activeIndex, visibleThreads, router]);

  // Sync keyboard changes back to active selection state
  useEffect(() => {
    if (activeIndex !== null && visibleThreads[activeIndex]) {
      setSelectedThreadId(visibleThreads[activeIndex].threadId);
    }
  }, [activeIndex]);

  const handleSelectThread = (threadId: string) => {
    setSelectedThreadId(threadId);
    setMobileView("detail");
  };

  const handleArchiveThread = (threadId: string) => {
    setArchivedIds((prev) => [...prev, threadId]);
    toast.success("Dossier archived", {
      description: "Dossier has been moved to communications archive.",
    });
    setMobileView("list");
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-full min-h-[calc(100vh-120px)] text-[#D9D1C1]">
      {/* Dossier List Column */}
      <div className={cn(
        "lg:col-span-8 flex flex-col min-w-0 h-full",
        mobileView === "detail" ? "hidden lg:flex" : "flex"
      )}>
        {/* Executive Briefing Strip */}
        {!isLoading && !isError && visibleThreads.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <ExecutiveBriefing threads={visibleThreads} meetingsCount={meetingsCount} />
          </motion.div>
        )}

        {/* Header */}
        <div className="border-b border-[#b08d57]/15 pb-4 mb-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-bold tracking-tight text-[#D9D1C1] font-serif uppercase">
              {title}
            </h1>
            <p className="text-xs text-[#D9D1C1]/50 font-mono">
              {subtitle}
            </p>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mt-4">
            <div className="flex flex-wrap items-center gap-2">
              {headerActions}
            </div>
            <div>
              {pagination}
            </div>
          </div>
        </div>

        {/* Content list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center gap-3 py-16 justify-center">
              <Spinner className="text-[#b08d57]" />
              <span className="text-[#D9D1C1]/60 font-mono text-xs uppercase">Retrieving Records…</span>
            </div>
          )}

          {isError && (
            <div className="py-8 text-center text-red-500 font-mono text-sm border border-red-900/20 bg-red-950/5 rounded-lg p-4">
              Error retrieving files: {error?.message ?? "An unexpected anomaly occurred."}
            </div>
          )}

          {!isLoading && !isError && visibleThreads.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <ArchiveIllustration />
              <h3 className="font-serif text-lg font-semibold text-[#D9D1C1] mb-2">
                No correspondence detected.
              </h3>
              <p className="text-xs text-[#D9D1C1]/40 font-mono max-w-xs uppercase">
                All records triaged. Standby for new transmissions.
              </p>
            </div>
          )}

          {!isLoading && !isError && visibleThreads.length > 0 && (
            <motion.div 
              variants={containerVariants}
              initial="hidden"
              animate="show"
              className="flex flex-col gap-3"
            >
              {visibleThreads.map((thread, index) => {
                const isSelected = selectedThreadId === thread.threadId;
                const p = thread.priority || "MEDIUM";
                const s = thread.priorityScore !== null && thread.priorityScore !== undefined ? thread.priorityScore : 0.5;
                const isCritical = p === "HIGH" && s >= 0.85;
                const isHigh = p === "HIGH" && s < 0.85;
                const isLow = p === "LOW";

                return (
                  <motion.div
                    key={thread.threadId}
                    variants={itemVariants}
                    onClick={() => handleSelectThread(thread.threadId)}
                    className={cn(
                      "relative flex flex-col cursor-pointer border border-[#b08d57]/15 rounded-md transition-all duration-300 hover:translate-y-[-2px] hover:shadow-[0_4px_12px_rgba(176,141,87,0.08)]",
                      isSelected 
                        ? "bg-[#b08d57]/12 shadow-[inset_4px_0_0_0_#b08d57] border-[#b08d57]/45" 
                        : "bg-[#1d1b18] border-[#b08d57]/15 hover:bg-[#262420] hover:border-[#b08d57]/30",
                      isCritical
                        ? "border-l-4 border-l-[#A81B1D] py-6 px-6"
                        : isHigh
                        ? "border-l-2 border-l-[#d4af37] py-5 px-5"
                        : isLow
                        ? "border-l border-l-[#474135]/50 py-3.5 px-5 text-[#D9D1C1]/85"
                        : "border-l border-l-[#4e5870]/40 py-4.5 px-5 text-[#D9D1C1]"
                    )}
                  >
                    {/* Subject Line (Primary) */}
                    <div className={cn(
                      "font-serif font-bold text-[#D9D1C1] tracking-tight leading-snug",
                      isCritical ? "text-xl mb-1.5" : isHigh ? "text-lg mb-1.5" : isLow ? "text-sm mb-1" : "text-base mb-1"
                    )}>
                      {thread.subject || "(No Subject)"}
                    </div>

                    {/* Sender (Monospace, Secondary) */}
                    <div className="font-mono text-[#b08d57]/90 tracking-wider mb-2 text-xs">
                      From: {thread.sender}
                    </div>

                    {/* AI Focus Summary (Serif, Tertiary) */}
                    <div className={cn(
                      "font-serif leading-relaxed mb-3",
                      isCritical ? "text-sm font-medium text-[#D9D1C1]" : isLow ? "text-xs text-[#D9D1C1]/65" : "text-sm text-[#D9D1C1]/75"
                    )}>
                      {thread.priorityReason ? (
                        <span className="inline-flex items-center flex-wrap gap-1">
                          <span className="text-[8px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-[#b08d57]/10 text-[#b08d57] border border-[#b08d57]/20 select-none mr-1.5 font-bold not-italic">
                            Triage Reason
                          </span>
                          <span className="italic">&ldquo;{thread.priorityReason}&rdquo;</span>
                        </span>
                      ) : (
                        <p className="line-clamp-2">{thread.snippet}</p>
                      )}
                    </div>

                    {/* Metadata & Actions */}
                    <div className="flex items-center justify-between gap-4 mt-auto">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-[#D9D1C1]/40 uppercase tracking-widest select-none">
                          REF-{String(1000 + index).slice(1)}/GML
                        </span>
                        {thread.isActionRequired && (
                          <span className="text-[8px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-[#b08d57]/10 text-[#b08d57] border border-[#b08d57]/15">
                            Action Required
                          </span>
                        )}
                        {thread.isReplyNeeded && (
                          <span className="text-[8px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-[#5c0e10]/15 text-[#ffb8b8] border border-[#8f191b]/20">
                            Reply Needed
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] font-mono text-[#D9D1C1]/50">
                          {formatThreadDate(thread.date)}
                        </span>
                        <PrioritySeal priority={thread.priority} score={thread.priorityScore} />
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </div>
      </div>

      {/* Context Rail Column */}
      <div className={cn(
        "lg:col-span-4 h-full bg-[#181715] border border-[#b08d57]/15 rounded-lg p-5 overflow-y-auto shadow-lg",
        mobileView === "detail" ? "flex flex-col" : "hidden lg:flex lg:flex-col"
      )}>
        <ContextRail 
          thread={activeThread} 
          threads={visibleThreads}
          onArchiveThread={handleArchiveThread}
          onBackToList={() => setMobileView("list")}
        />
      </div>
    </div>
  );
}

// ── Category Inbox View ─────────────────────────────────────────────

function CategoryInbox({
  category,
  page,
  onNavigate,
}: {
  category: string;
  page: number;
  onNavigate: (newCategory: string, newPage: number) => void;
}) {
  const { data, isLoading, isError, error } = useCategoryEmails(category, { maxResults: PAGE_SIZE, page: page - 1 });
  const threads = data?.threads ?? [];

  return (
    <DossierLayout
      title="Correspondence Archive"
      subtitle={`${category.charAt(0) + category.slice(1).toLowerCase()} category dossier record`}
      threads={threads}
      isLoading={isLoading}
      isError={isError}
      error={error}
      headerActions={
        <div className="flex border border-[#b08d57]/20 bg-black/40 p-0.5 rounded-lg">
          {CATEGORIES.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => onNavigate(key, 1)}
              className={`px-4 py-1.5 text-xs font-mono uppercase tracking-wider rounded-md transition-all cursor-pointer ${
                category === key
                  ? "bg-[#b08d57] text-black font-bold shadow-sm"
                  : "bg-transparent text-[#D9D1C1]/60 hover:text-[#D9D1C1] hover:bg-white/5"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      }
      pagination={
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate(category, page - 1)}
            disabled={page <= 1}
            className="border-white/10 text-xs font-mono uppercase bg-transparent text-[#D9D1C1] hover:bg-white/5"
          >
            <ChevronLeftIcon className="size-4" />
            <span>Prev</span>
          </Button>
          <span className="text-xs font-mono text-[#D9D1C1]/50 min-w-16 text-center">PAGE {page}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate(category, page + 1)}
            disabled={threads.length < PAGE_SIZE}
            className="border-white/10 text-xs font-mono uppercase bg-transparent text-[#D9D1C1] hover:bg-white/5"
          >
            <span>Next</span>
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      }
    />
  );
}

// ── Gmail Search Results View ────────────────────────────────────────

function GmailSearchResults({ query }: { query: string }) {
  const { data, isLoading, isError, error } = useSearchEmails(query, { maxResults: 20 });
  const threads = data?.threads ?? [];

  return (
    <DossierLayout
      title="Gmail Search"
      subtitle={`Dossiers matching search criteria "${query}"`}
      threads={threads}
      isLoading={isLoading}
      isError={isError}
      error={error}
    />
  );
}

// ── AI Search Results View ──────────────────────────────────────────

function AiSearchResults({ query }: { query: string }) {
  const { data, isLoading, isError, error } = useSearchLocalEmails(query);
  const threads = data?.threads ?? [];

  return (
    <DossierLayout
      title="AI Search"
      subtitle={`Semantic query match for "${query}"`}
      threads={threads}
      isLoading={isLoading}
      isError={isError}
      error={error}
    />
  );
}

// ── Priority Inbox View ──────────────────────────────────────────────

function PriorityInbox({
  page,
  onNavigate,
}: {
  page: number;
  onNavigate: (newCategory: string, newPage: number) => void;
}) {
  const [filter, setFilter] = React.useState<"ALL" | "HIGH" | "MEDIUM" | "LOW">("ALL");

  const priorities = React.useMemo(() => {
    if (filter === "ALL") return ["HIGH", "MEDIUM", "LOW"];
    return [filter];
  }, [filter]);

  const { data: countsData } = usePriorityCounts();
  const counts = countsData ?? { HIGH: 0, MEDIUM: 0, LOW: 0, ALL: 0 };

  const { data, isLoading, isError, error } = usePriorityEmails({
    priorities,
    maxResults: PAGE_SIZE,
    page: page - 1,
  });
  const threads = data?.threads ?? [];

  React.useEffect(() => {
    onNavigate("PRIORITY", 1);
  }, [filter]);

  return (
    <DossierLayout
      title="Priority Correspondence"
      subtitle="Your most important conversations ranked by urgency and context."
      threads={threads}
      isLoading={isLoading}
      isError={isError}
      error={error}
      headerActions={
        <div className="flex border border-[#b08d57]/20 bg-black/40 p-0.5 rounded-lg flex-wrap gap-1">
          {(["ALL", "HIGH", "MEDIUM", "LOW"] as const).map((key) => {
            const count = key === "ALL" ? counts.ALL : counts[key];
            const label = key === "ALL" ? "All" : key.charAt(0) + key.slice(1).toLowerCase();
            const isActive = filter === key;
            
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`px-4 py-1.5 text-xs font-mono uppercase tracking-wider rounded-md transition-all cursor-pointer ${
                  isActive
                    ? key === "HIGH"
                      ? "bg-[#6b0b0d] text-[#ffcaca] font-bold"
                      : key === "MEDIUM"
                      ? "bg-[#b08d57] text-black font-bold"
                      : key === "LOW"
                      ? "bg-[#161513] text-[#736a5c] font-bold"
                      : "bg-[#b08d57] text-black font-bold"
                    : "bg-transparent text-[#D9D1C1]/60 hover:text-[#D9D1C1] hover:bg-white/5"
                }`}
              >
                {label} ({count})
              </button>
            );
          })}
        </div>
      }
      pagination={
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("PRIORITY", page - 1)}
            disabled={page <= 1}
            className="border-white/10 text-xs font-mono uppercase bg-transparent text-[#D9D1C1] hover:bg-white/5"
          >
            <ChevronLeftIcon className="size-4" />
            <span>Prev</span>
          </Button>
          <span className="text-xs font-mono text-[#D9D1C1]/50 min-w-16 text-center">PAGE {page}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("PRIORITY", page + 1)}
            disabled={threads.length < PAGE_SIZE}
            className="border-white/10 text-xs font-mono uppercase bg-transparent text-[#D9D1C1] hover:bg-white/5"
          >
            <span>Next</span>
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      }
    />
  );
}

// ── Root Page ───────────────────────────────────────────────────────

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const category = searchParams.get("category") ?? "PRIMARY";
  const page = parseInt(searchParams.get("page") ?? "1", 10);
  const mode = searchParams.get("mode");
  const q = searchParams.get("q") ?? "";
  const aiq = searchParams.get("aiq") ?? "";
  const isGmailSearch = (!mode || mode === "gmail") && q.length > 0;
  const isAiSearch = mode === "ai" && aiq.length > 0;

  // UPDATES category fallback
  useEffect(() => {
    if (category === "UPDATES") {
      const p = new URLSearchParams();
      p.set("category", "PRIMARY");
      if (page > 1) p.set("page", String(page));
      router.replace(`/inbox?${p.toString()}`);
    }
  }, [category, page, router]);

  const navigateTo = (newCategory: string, newPage: number) => {
    const p = new URLSearchParams();
    p.set("category", newCategory);
    if (newPage > 1) p.set("page", String(newPage));
    router.replace(`/inbox?${p.toString()}`);
  };

  if (isAiSearch) {
    return <AiSearchResults query={aiq} />;
  }

  if (isGmailSearch) {
    return <GmailSearchResults query={q} />;
  }

  if (category === "PRIORITY") {
    return <PriorityInbox page={page} onNavigate={navigateTo} />;
  }

  return <CategoryInbox category={category} page={page} onNavigate={navigateTo} />;
}
