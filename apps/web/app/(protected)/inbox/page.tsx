"use client";

import React, { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCategoryEmails, useSearchLocalEmails, useSearchEmails } from "@web/hooks/api/gmail";
import { frontendLogger } from "@web/lib/frontend-logger";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@web/components/ui/table";
import { Button } from "@web/components/ui/button";
import { Spinner } from "@web/components/ui/spinner";
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";

const CATEGORIES = [
  { key: "PRIMARY", label: "Primary" },
  { key: "PROMOTIONS", label: "Promotions" },
  { key: "SOCIAL", label: "Social" },
  { key: "FORUMS", label: "Forums" },
] as const;

const PAGE_SIZE = 50;

/**
 * Shared table of thread rows. Used by both category inbox and search results.
 */
function ThreadTable({ threads, onRowClick }: {
  threads: Array<{ threadId: string; sender: string; subject: string; date: string; snippet: string }>;
  onRowClick: (threadId: string) => void;
}) {
  if (threads.length === 0) return null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead style={{ width: "25%" }}>Sender</TableHead>
          <TableHead style={{ width: "50%" }}>Subject</TableHead>
          <TableHead style={{ width: "25%" }}>Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {threads.map((thread) => (
          <TableRow
            key={thread.threadId}
            onClick={() => onRowClick(thread.threadId)}
            style={{ cursor: "pointer" }}
          >
            <TableCell>{thread.sender}</TableCell>
            <TableCell>{thread.subject}</TableCell>
            <TableCell style={{ whiteSpace: "nowrap" }}>{thread.date}</TableCell>
          </TableRow>
        ))}
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

  return <CategoryInbox category={category} page={page} onNavigate={navigateTo} />;
}

