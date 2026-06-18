"use client";

import React, { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCategoryEmails, useSearchLocalEmails, useSearchEmails, usePriorityEmails, usePriorityCounts } from "@web/hooks/api/gmail";
import { frontendLogger } from "@web/lib/frontend-logger";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@web/components/ui/table";
import { Button } from "@web/components/ui/button";
import { Spinner } from "@web/components/ui/spinner";
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon, SparklesIcon } from "lucide-react";

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

/**
 * Shared table of thread rows. Used by both category inbox and search results.
 */
function ThreadTable({ threads, onRowClick }: {
  threads: Array<{
    threadId: string;
    sender: string;
    subject: string;
    date: string;
    snippet: string;
    priority?: string;
    priorityScore?: number | null;
    priorityReason?: string | null;
    isActionRequired?: boolean;
    isReplyNeeded?: boolean;
    isUnread?: boolean;
  }>;
  onRowClick: (threadId: string) => void;
}) {
  if (threads.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead style={{ width: "20%" }}>Sender</TableHead>
          <TableHead style={{ width: "15%" }}>Priority</TableHead>
          <TableHead style={{ width: "45%" }}>Subject</TableHead>
          <TableHead style={{ width: "20%" }}>Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {threads.map((thread) => {
          const priorityColor = thread.priority === "HIGH"
            ? "bg-red-100 text-red-800 border-red-200"
            : thread.priority === "MEDIUM"
            ? "bg-amber-100 text-amber-800 border-amber-200"
            : "bg-gray-100 text-gray-800 border-gray-200";

          return (
            <TableRow
              key={thread.threadId}
              onClick={() => onRowClick(thread.threadId)}
              style={{ cursor: "pointer" }}
              title={thread.priorityReason || undefined}
            >
              <TableCell className={thread.isUnread ? "font-bold text-foreground" : "font-medium"}>
                <div className="flex items-center gap-2">
                  {thread.isUnread && (
                    <span className="size-2 rounded-full bg-blue-600 shrink-0" title="Unread" />
                  )}
                  <span className="truncate max-w-[150px]">{thread.sender}</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1 items-start">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${priorityColor}`}>
                    {thread.priority || "MEDIUM"}
                  </span>
                  {(thread.isActionRequired || thread.isReplyNeeded) && (
                    <span className="text-[9px] font-semibold px-2 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200">
                      {thread.isActionRequired && "Action Required"}
                      {thread.isActionRequired && thread.isReplyNeeded && " / "}
                      {thread.isReplyNeeded && "Reply Needed"}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className={thread.isUnread ? "font-bold text-black" : "font-semibold text-gray-900"}>{thread.subject}</div>
                <div className="text-xs text-gray-500 truncate max-w-xl">{thread.snippet}</div>
              </TableCell>
              <TableCell style={{ whiteSpace: "nowrap" }} className="text-sm text-gray-500">
                {formatThreadDate(thread.date)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
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
  const router = useRouter();

  return (
    <div>
      {/* Category tabs */}
      <div className="flex gap-1 mb-2">
        {CATEGORIES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onNavigate(key, 1)}
            className={`px-4 py-1.5 text-sm rounded-full transition-colors ${
              category === key
                ? "bg-blue-600 text-white font-semibold"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Pagination — below tabs, above table */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-muted-foreground">
          {isLoading ? "Loading…" : threads.length === 0 ? `No emails in ${category.toLowerCase()}.` : `Showing ${threads.length} emails`}
        </span>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => onNavigate(category, page - 1)} disabled={page <= 1}>
            <ChevronLeftIcon className="size-4" />
            <span>Previous</span>
          </Button>
          <span className="text-sm text-muted-foreground min-w-16 text-center">Page {page}</span>
          <Button variant="outline" size="sm" onClick={() => onNavigate(category, page + 1)} disabled={threads.length < PAGE_SIZE}>
            <span>Next</span>
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-2"><Spinner /><span className="text-muted-foreground">Loading…</span></div>
      )}

      {isError && (
        <p className="text-red-500">Error: {error?.message ?? "Failed to load emails"}</p>
      )}

      {!isLoading && !isError && (
        <ThreadTable
          threads={threads}
          onRowClick={(threadId) => router.push(`/inbox/${threadId}`)}
        />
      )}
    </div>
  );
}

// ── Gmail Search Results View ────────────────────────────────────────

function GmailSearchResults({ query }: { query: string }) {
  const { data, isLoading, isError, error } = useSearchEmails(query, { maxResults: 20 });
  const router = useRouter();
  const threads = data?.threads ?? [];

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <SearchIcon className="size-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          Gmail search results for: <span className="font-semibold text-foreground">&ldquo;{query}&rdquo;</span>
        </span>
        <span className="text-xs text-muted-foreground ml-auto">
          {isLoading ? "Searching Gmail…" : `${threads.length} result${threads.length !== 1 ? "s" : ""}`}
        </span>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-2"><Spinner /><span className="text-muted-foreground">Searching your Gmail account…</span></div>
      )}

      {isError && (
        <p className="text-red-500">Search failed: {error?.message ?? "Unknown error"}</p>
      )}

      {!isLoading && !isError && threads.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <SearchIcon className="size-8" />
          <p>No results found for &ldquo;{query}&rdquo;.</p>
          <p className="text-sm">Try a different search term.</p>
        </div>
      )}

      {!isLoading && !isError && (
        <ThreadTable
          threads={threads}
          onRowClick={(threadId) => router.push(`/inbox/${threadId}`)}
        />
      )}
    </div>
  );
}

// ── AI Search Results View ──────────────────────────────────────────

function AiSearchResults({ query }: { query: string }) {
  const { data, isLoading, isError, error } = useSearchLocalEmails(query);
  const router = useRouter();
  const threads = data?.threads ?? [];

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <SearchIcon className="size-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          AI search results for: <span className="font-semibold text-foreground">&ldquo;{query}&rdquo;</span>
        </span>
        <span className="text-xs text-muted-foreground ml-auto">
          {isLoading ? "Searching…" : `${threads.length} result${threads.length !== 1 ? "s" : ""}`}
        </span>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-2"><Spinner /><span className="text-muted-foreground">Searching your emails…</span></div>
      )}

      {isError && (
        <p className="text-red-500">Search failed: {error?.message ?? "Unknown error"}</p>
      )}

      {!isLoading && !isError && threads.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <SearchIcon className="size-8" />
          <p>No results found for &ldquo;{query}&rdquo;.</p>
          <p className="text-sm">Try a different search term.</p>
        </div>
      )}

      {!isLoading && !isError && (
        <ThreadTable
          threads={threads}
          onRowClick={(threadId) => router.push(`/inbox/${threadId}`)}
        />
      )}
    </div>
  );
}

// ── Priority Triage View ─────────────────────────────────────────────

function PriorityTriageView({
  threads,
  onRowClick,
  showSectionHeaders,
}: {
  threads: Array<{
    threadId: string;
    sender: string;
    subject: string;
    date: string;
    snippet: string;
    priority?: string;
    priorityScore?: number | null;
    priorityReason?: string | null;
    isActionRequired?: boolean;
    isReplyNeeded?: boolean;
    isUnread?: boolean;
  }>;
  onRowClick: (threadId: string) => void;
  showSectionHeaders: boolean;
}) {
  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground border-2 border-dashed rounded-xl p-8 bg-card/50">
        <SparklesIcon className="size-10 text-indigo-500/80 mb-3 animate-pulse" />
        <h3 className="font-semibold text-lg text-foreground mb-1">Inbox Zero (AI Edition)</h3>
        <p className="text-sm text-center max-w-sm">No priority emails require your attention from the last 7 days.</p>
      </div>
    );
  }

  const sortedThreads = React.useMemo(() => {
    return [...threads].sort((a, b) => {
      // 1. priorityRank DESC (HIGH=3, MEDIUM=2, LOW=1)
      const priorityRank: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      const aPriority = priorityRank[a.priority as string] ?? 2;
      const bPriority = priorityRank[b.priority as string] ?? 2;
      if (aPriority !== bPriority) {
        return bPriority - aPriority;
      }

      // 2. isUnread DESC
      const aUnread = a.isUnread ? 1 : 0;
      const bUnread = b.isUnread ? 1 : 0;
      if (aUnread !== bUnread) {
        return bUnread - aUnread;
      }

      // 3. priorityScore DESC NULLS LAST
      const aScore = a.priorityScore;
      const bScore = b.priorityScore;
      if (aScore !== bScore) {
        if (aScore === null || aScore === undefined) return 1;
        if (bScore === null || bScore === undefined) return -1;
        return bScore - aScore;
      }

      // 4. receivedAt DESC
      const aTime = a.date ? new Date(a.date).getTime() : 0;
      const bTime = b.date ? new Date(b.date).getTime() : 0;
      return bTime - aTime;
    });
  }, [threads]);

  let lastPriority: string | null = null;

  return (
    <div className="grid gap-4 md:grid-cols-1 lg:grid-cols-2">
      {sortedThreads.map((thread) => {
        const score = thread.priorityScore !== null && thread.priorityScore !== undefined
          ? Math.round(thread.priorityScore * 100)
          : null;

        const currentPriority = thread.priority || "MEDIUM";
        const isNewPriority = showSectionHeaders && currentPriority !== lastPriority;
        if (showSectionHeaders) {
          lastPriority = currentPriority;
        }

        const priorityColor = currentPriority === "HIGH"
          ? "bg-red-100 text-red-800 border-red-200"
          : currentPriority === "MEDIUM"
          ? "bg-amber-100 text-amber-800 border-amber-200"
          : "bg-gray-100 text-gray-800 border-gray-200";

        const dotColor = currentPriority === "HIGH"
          ? "bg-red-500"
          : currentPriority === "MEDIUM"
          ? "bg-amber-500"
          : "bg-gray-400";

        return (
          <React.Fragment key={thread.threadId}>
            {isNewPriority && (
              <div className="col-span-full mt-4 first:mt-0 mb-2">
                <h3 className="text-xs font-bold tracking-wider text-muted-foreground uppercase flex items-center gap-2">
                  <span className={`size-2 rounded-full ${dotColor}`} />
                  {currentPriority} PRIORITY
                </h3>
                <div className="h-px bg-border mt-1" />
              </div>
            )}
            <div
              onClick={() => onRowClick(thread.threadId)}
              className={`group relative flex flex-col justify-between border bg-card hover:bg-accent/40 rounded-xl p-5 shadow-sm hover:shadow-md transition-all duration-300 cursor-pointer ${
                thread.isUnread
                  ? "border-blue-300 ring-1 ring-blue-100 hover:border-blue-400"
                  : "border-indigo-100/50 hover:border-indigo-200"
              }`}
            >
              {/* Header: Priority Indicator, Score, Date */}
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shadow-sm ${priorityColor}`}>
                    {currentPriority}
                  </span>
                  {score !== null ? (
                    <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                      Score: {score}
                    </span>
                  ) : (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                      Classification Pending
                    </span>
                  )}
                  {thread.isUnread && (
                    <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200">
                      New
                    </span>
                  )}
                  {(thread.isActionRequired || thread.isReplyNeeded) && (
                    <span className="text-[9px] font-semibold px-2 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200">
                      {thread.isActionRequired && "Action Required"}
                      {thread.isActionRequired && thread.isReplyNeeded && " / "}
                      {thread.isReplyNeeded && "Reply Needed"}
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                  {formatThreadDate(thread.date)}
                </span>
              </div>

              {/* Content: Sender, Subject, Reason, Snippet */}
              <div className="flex-1 mb-4">
                <div className={`text-sm text-foreground mb-1 ${thread.isUnread ? "font-bold" : "font-semibold"}`}>
                  {thread.sender}
                </div>

                {/* Subject: Visible but secondary / de-emphasized */}
                <div className="text-xs text-muted-foreground font-medium mb-3 truncate max-w-md">
                  Subject: {thread.subject || "(no subject)"}
                </div>
                
                {thread.priorityReason && (
                  <div className="text-sm font-medium bg-indigo-50/50 text-indigo-950 border border-indigo-100/50 rounded-lg p-3 mb-2 italic">
                    <span className="block text-[10px] uppercase tracking-wider text-indigo-500 font-bold not-italic mb-1">
                      AI Reason
                    </span>
                    &ldquo;{thread.priorityReason}&rdquo;
                  </div>
                )}

                <div className="text-xs text-muted-foreground line-clamp-2 mt-1">
                  {thread.snippet}
                </div>
              </div>
              
              {/* Action footer */}
              <div className="flex items-center justify-end text-xs text-indigo-500 font-semibold opacity-0 group-hover:opacity-100 transition-opacity">
                Triage Message →
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
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

  // Map filters
  const priorities = React.useMemo(() => {
    if (filter === "ALL") return ["HIGH", "MEDIUM", "LOW"];
    return [filter];
  }, [filter]);

  // Fetch count hook
  const { data: countsData } = usePriorityCounts();
  const counts = countsData ?? { HIGH: 0, MEDIUM: 0, LOW: 0, ALL: 0 };

  // Fetch emails hook
  const { data, isLoading, isError, error } = usePriorityEmails({
    priorities,
    maxResults: PAGE_SIZE,
    page: page - 1,
  });
  const threads = data?.threads ?? [];
  const router = useRouter();

  // Reset page when filter changes
  React.useEffect(() => {
    onNavigate("PRIORITY", 1);
  }, [filter]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <SparklesIcon className="size-5 text-indigo-500 animate-pulse" />
        <h2 className="text-lg font-bold text-foreground">Priority Attention Layer</h2>
        <span className="text-xs text-muted-foreground">
          Surfacing important messages from the last 7 days.
        </span>
      </div>

      {/* Filter Pill Button Group */}
      <div className="flex flex-wrap gap-2 mb-4">
        {(["ALL", "HIGH", "MEDIUM", "LOW"] as const).map((key) => {
          const count = key === "ALL" ? counts.ALL : counts[key];
          const label = key === "ALL" ? "All" : key.charAt(0) + key.slice(1).toLowerCase();
          const isActive = filter === key;
          
          return (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-4 py-1.5 text-xs font-semibold rounded-full border transition-all ${
                isActive
                  ? key === "HIGH"
                    ? "bg-red-600 border-red-600 text-white shadow-sm"
                    : key === "MEDIUM"
                    ? "bg-amber-500 border-amber-500 text-white shadow-sm"
                    : key === "LOW"
                    ? "bg-gray-600 border-gray-600 text-white shadow-sm"
                    : "bg-indigo-600 border-indigo-600 text-white shadow-sm"
                  : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground border-border"
              }`}
            >
              {label} ({count})
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-muted-foreground">
          {isLoading ? "Loading…" : threads.length === 0 ? "No items requiring attention." : `Showing ${threads.length} triage items`}
        </span>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => onNavigate("PRIORITY", page - 1)} disabled={page <= 1}>
            <ChevronLeftIcon className="size-4" />
            <span>Previous</span>
          </Button>
          <span className="text-sm text-muted-foreground min-w-16 text-center">Page {page}</span>
          <Button variant="outline" size="sm" onClick={() => onNavigate("PRIORITY", page + 1)} disabled={threads.length < PAGE_SIZE}>
            <span>Next</span>
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-2">
          <Spinner />
          <span className="text-muted-foreground">Triaging inbox…</span>
        </div>
      )}

      {isError && (
        <p className="text-red-500">Error: {error?.message ?? "Failed to load priority emails"}</p>
      )}

      {!isLoading && !isError && (
        <PriorityTriageView
          threads={threads}
          onRowClick={(threadId) => router.push(`/inbox/${threadId}`)}
          showSectionHeaders={filter === "ALL"}
        />
      )}
    </div>
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

  // UPDATES has been merged into PRIMARY — redirect to PRIMARY
  useEffect(() => {
    if (category === "UPDATES") {
      frontendLogger.info("[INBOX_UI]", "UPDATES category requested — redirecting to PRIMARY", { page });
      const p = new URLSearchParams();
      p.set("category", "PRIMARY");
      if (page > 1) p.set("page", String(page));
      router.replace(`/inbox?${p.toString()}`);
    }
  }, [category, page, router]);

  frontendLogger.info("[INBOX_UI]", "InboxPage render", { category, page, mode, q, aiq, isGmailSearch, isAiSearch });

  const navigateTo = (newCategory: string, newPage: number) => {
    frontendLogger.info("[INBOX_UI]", "tab or pagination navigate", {
      fromCategory: category, fromPage: page, toCategory: newCategory, toPage: newPage,
    });
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

