"use client";

import React, { useCallback, useMemo, useRef } from "react";
import { useThreads, useSearchEmails, useSearchLocalEmails } from "@web/hooks/api/gmail";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@web/components/ui/table";
import { Button } from "@web/components/ui/button";
import { Spinner } from "@web/components/ui/spinner";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

const PAGE_SIZE = 20;

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchMode = (searchParams.get("mode") as "gmail" | "ai") ?? "gmail";
  const query = searchMode === "gmail"
    ? (searchParams.get("q") ?? "")
    : (searchParams.get("aiq") ?? "");
  const rawPageToken = searchParams.get("pageToken");
  const pageToken = rawPageToken ?? undefined;

  // Gmail mode: use existing Corsair search or threads listing
  const threadsResult = useThreads(
    query ? undefined : { maxResults: PAGE_SIZE, pageToken },
  );
  const gmailSearchResult = useSearchEmails(query, {
    maxResults: PAGE_SIZE,
    pageToken,
  });

  // Dobbie mode: use local ILIKE search on indexed emails only
  const localSearchResult = useSearchLocalEmails(query);

  const { data, isLoading, isError, error } =
    searchMode === "ai" && query
      ? {
          data: localSearchResult.data?.threads
            ? { threads: localSearchResult.data.threads, nextPageToken: null }
            : undefined,
          isLoading: localSearchResult.isLoading,
          isError: localSearchResult.isError,
          error: localSearchResult.error,
        }
      : query
        ? {
            data: gmailSearchResult.data,
            isLoading: gmailSearchResult.isLoading,
            isError: gmailSearchResult.isError,
            error: gmailSearchResult.error,
          }
        : {
            data: threadsResult.data,
            isLoading: threadsResult.isLoading,
            isError: threadsResult.isError,
            error: threadsResult.error,
          };

  // Page token history stack for previous navigation
  const prevTokensRef = useRef<string[]>([]);

  const navigatePage = useCallback(
    (nextToken: string | null, isNext: boolean) => {
      const params = new URLSearchParams(searchParams.toString());
      const currentToken = rawPageToken;

      if (isNext && currentToken) {
        // Going forward: push current token onto history
        prevTokensRef.current = [...prevTokensRef.current, currentToken];
      } else if (!isNext && nextToken === null) {
        // Going back to first page: clear history
        prevTokensRef.current = [];
      }

      if (nextToken) {
        params.set("pageToken", nextToken);
      } else {
        params.delete("pageToken");
      }

      router.replace(`/inbox?${params.toString()}`);
    },
    [rawPageToken, router, searchParams],
  );

  const handleNext = useCallback(() => {
    if (data?.nextPageToken) {
      navigatePage(data.nextPageToken, true);
    }
  }, [data?.nextPageToken, navigatePage]);

  const handlePrevious = useCallback(() => {
    const stack = prevTokensRef.current;
    if (stack.length > 0) {
      // Pop the last token off
      const prevToken = stack[stack.length - 1]!;
      prevTokensRef.current = stack.slice(0, -1);
      navigatePage(prevToken, false);
    } else {
      // Back to first page
      navigatePage(null, false);
    }
  }, [navigatePage]);

  const hasPrevious = rawPageToken !== null;
  const hasNext = Boolean(data?.nextPageToken);
  const isSearchActive = query.length > 0;
  const isDobbieSearch = searchMode === "ai" && isSearchActive;

  // Page number indicator
  const pageNumber = useMemo(() => {
    if (!rawPageToken) return 1;
    // Approximate: count history + 2 (current page)
    return prevTokensRef.current.length + 2;
  }, [rawPageToken]);

  const threads = data?.threads ?? [];

  if (isLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0" }}>
        <Spinner />
        <span style={{ color: "var(--muted-foreground, #888)" }}>Loading threads…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div style={{ padding: "0.5rem 0" }}>
        <p style={{ color: "var(--destructive, #ef4444)" }}>
          Error: {error?.message ?? "Failed to load threads"}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Search status message */}
      {isDobbieSearch && (
        <div style={{ color: "var(--muted-foreground, #888)", fontSize: "0.85rem", marginBottom: "1rem" }}>
          <p>
            Dobbie search results for: <strong>{query}</strong>
          </p>
          <p style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}>
            Results from all your indexed emails.
          </p>
          {threads.length === 0 && (
            <p style={{ marginTop: "0.5rem", color: "var(--destructive, #ef4444)" }}>
              No results found. Try syncing more emails or using different search terms.
            </p>
          )}
        </div>
      )}

      {isSearchActive && !isDobbieSearch && (
        <p style={{ color: "var(--muted-foreground, #888)", fontSize: "0.85rem", marginBottom: "1rem" }}>
          Search results for: <strong>{query}</strong>
          {threads.length === 0 && " — No results found."}
        </p>
      )}

      {!isSearchActive && threads.length === 0 && (
        <p style={{ color: "var(--muted-foreground, #888)" }}>No threads found.</p>
      )}

      {threads.length > 0 && (
        <>
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

          {/* Pagination (Gmail mode only — Dobbie has no pages) */}
          {!isDobbieSearch && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "1rem",
              marginTop: "1.25rem",
              paddingBottom: "1rem",
            }}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrevious}
              disabled={!hasPrevious}
            >
              <ChevronLeftIcon className="size-4" />
              <span>Previous</span>
            </Button>

            <span style={{ fontSize: "0.85rem", color: "var(--muted-foreground, #888)", minWidth: "4rem", textAlign: "center" }}>
              Page {pageNumber}
            </span>

            <Button
              variant="outline"
              size="sm"
              onClick={handleNext}
              disabled={!hasNext}
            >
              <span>Next</span>
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
          )}
        </>
      )}
    </div>
  );
}
