"use client";

import React, { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCategoryEmails } from "@web/hooks/api/gmail";
import { frontendLogger } from "@web/lib/frontend-logger";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@web/components/ui/table";
import { Button } from "@web/components/ui/button";
import { Spinner } from "@web/components/ui/spinner";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

const CATEGORIES = [
  { key: "PRIMARY", label: "Primary" },
  { key: "PROMOTIONS", label: "Promotions" },
  { key: "SOCIAL", label: "Social" },
  { key: "FORUMS", label: "Forums" },
] as const;

const PAGE_SIZE = 50;

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const category = searchParams.get("category") ?? "PRIMARY";
  const page = parseInt(searchParams.get("page") ?? "1", 10);

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

  frontendLogger.info("[INBOX_UI]", "InboxPage render", { category, page, PAGE_SIZE });

  const { data, isLoading, isError, error } = useCategoryEmails(category, { maxResults: PAGE_SIZE, page: page - 1 });

  const threads = data?.threads ?? [];

  frontendLogger.info("[INBOX_UI]", "InboxPage threads state", {
    category, page, threadCount: threads.length, isLoading, isError,
  });

  const navigateTo = (newCategory: string, newPage: number) => {
    frontendLogger.info("[INBOX_UI]", "tab or pagination navigate", {
      fromCategory: category, fromPage: page, toCategory: newCategory, toPage: newPage,
    });
    const p = new URLSearchParams();
    p.set("category", newCategory);
    if (newPage > 1) p.set("page", String(newPage));
    router.replace(`/inbox?${p.toString()}`);
  };

  return (
    <div>
      {/* Category tabs */}
      <div className="flex gap-1 mb-2">
        {CATEGORIES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => navigateTo(key, 1)}
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
          <Button variant="outline" size="sm" onClick={() => navigateTo(category, page - 1)} disabled={page <= 1}>
            <ChevronLeftIcon className="size-4" />
            <span>Previous</span>
          </Button>
          <span className="text-sm text-muted-foreground min-w-16 text-center">Page {page}</span>
          <Button variant="outline" size="sm" onClick={() => navigateTo(category, page + 1)} disabled={threads.length < PAGE_SIZE}>
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

      {!isLoading && !isError && threads.length > 0 && (
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
                onClick={() => router.push(`/inbox/${thread.threadId}`)}
                style={{ cursor: "pointer" }}
              >
                <TableCell>{thread.sender}</TableCell>
                <TableCell>{thread.subject}</TableCell>
                <TableCell style={{ whiteSpace: "nowrap" }}>{thread.date}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

