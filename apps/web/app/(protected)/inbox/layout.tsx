"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LogOutIcon, PencilIcon, SearchIcon, XIcon, CalendarDaysIcon, BotIcon, DownloadIcon, SparklesIcon } from "lucide-react";
import { Input } from "@web/components/ui/input";
import { Button } from "@web/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@web/components/ui/avatar";
import { ComposeDialog } from "@web/components/inbox/compose-dialog";
import { authClient, useSession } from "@web/lib/auth-client";
import { useSyncEmails, useStoredEmailCount, useGenerateEmbeddings, usePendingEmbeddingsCount } from "@web/hooks/api/gmail";

const DEBOUNCE_MS = 300;

type SearchMode = "gmail" | "ai";

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchMode: SearchMode = (searchParams.get("mode") as SearchMode) ?? "gmail";
  const currentQuery = searchMode === "gmail"
    ? (searchParams.get("q") ?? "")
    : (searchParams.get("aiq") ?? "");
  const [localValue, setLocalValue] = useState(currentQuery);
  const [composeOpen, setComposeOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const { data: session } = useSession();
  const { syncEmailsAsync, isPending: syncing } = useSyncEmails();
  const { data: countData, refetch: refetchCount } = useStoredEmailCount();
  const { generateEmbeddingsAsync, isPending: embedding } = useGenerateEmbeddings();
  const { data: pendingData, refetch: refetchPending } = usePendingEmbeddingsCount();

  const initials = useMemo(() => {
    const name = session?.user?.name;
    return name ? getInitials(name) : "?";
  }, [session?.user?.name]);

  const avatarUrl = session?.user?.image ?? null;

  // Keep local input in sync when URL changes externally (e.g. back/forward)
  useEffect(() => {
    setLocalValue(currentQuery);
  }, [currentQuery]);

  const setSearchMode = useCallback(
    (mode: SearchMode) => {
      const params = new URLSearchParams(searchParams.toString());
      if (mode === "gmail") {
        params.delete("aiq");
        params.delete("mode");
      } else {
        params.delete("q");
        params.set("mode", "ai");
      }
      params.delete("page");
      const path = params.size ? `/inbox?${params.toString()}` : "/inbox";
      router.replace(path);
    },
    [router, searchParams],
  );

  const pushQuery = useCallback(
    (q: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (q) {
        if (searchMode === "gmail") {
          params.set("q", q);
        } else {
          params.set("aiq", q);
        }
        params.delete("page");
      } else {
        if (searchMode === "gmail") params.delete("q");
        else params.delete("aiq");
        params.delete("page");
      }
      const path = params.size ? `/inbox?${params.toString()}` : "/inbox";
      router.replace(path);
    },
    [router, searchParams, searchMode],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setLocalValue(value);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        pushQuery(value);
      }, DEBOUNCE_MS);
    },
    [pushQuery],
  );

  const handleClear = useCallback(() => {
    setLocalValue("");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    pushQuery("");
  }, [pushQuery]);

  const handleLogout = useCallback(async () => {
    await authClient.signOut();
    router.push("/sign-in");
  }, [router]);

  const handleSync = useCallback(async () => {
    try {
      const result = await syncEmailsAsync();
      refetchCount();
      refetchPending();
      console.log(`Synced ${result.synced} emails`);
    } catch (err) {
      console.error("Sync failed:", err);
    }
  }, [syncEmailsAsync, refetchCount, refetchPending]);

  const handleGenerateEmbeddings = useCallback(async () => {
    try {
      const result = await generateEmbeddingsAsync();
      refetchPending();
      console.log(`Embedded ${result.embedded} emails`);
    } catch (err) {
      console.error("Embedding failed:", err);
    }
  }, [generateEmbeddingsAsync, refetchPending]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="px-8 py-6">
      {/* Top bar: profile + search + compose */}
      <div className="flex items-center gap-4 mb-6">
        {/* Profile avatar */}
        <Avatar className="size-9 shrink-0 ring-2 ring-chart-1/50">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={session?.user?.name ?? "User"} />}
          <AvatarFallback className="bg-chart-1 text-primary-foreground text-sm font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>

        {/* Search mode toggle + input */}
        <div className="flex flex-col gap-1.5 flex-1 max-w-2xl">
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border bg-muted p-0.5 shrink-0">
              <button
                onClick={() => { setSearchMode("gmail"); setLocalValue(""); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  searchMode === "gmail"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Search Gmail
              </button>
              <button
                onClick={() => { setSearchMode("ai"); setLocalValue(""); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  searchMode === "ai"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Ask Dobbie
              </button>
            </div>

            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                type="text"
                placeholder={
                  searchMode === "gmail"
                    ? "Search your entire Gmail account…"
                    : "Ask Dobbie about your emails…"
                }
                value={localValue}
                onChange={handleChange}
                className="pl-9 pr-9"
              />
              {localValue && (
                <button
                  onClick={handleClear}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 flex items-center justify-center text-muted-foreground hover:text-foreground rounded-full hover:bg-muted transition-colors"
                >
                  <XIcon className="size-4" />
                </button>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground pl-1 h-4">
            {searchMode === "ai"
              ? <>Searching indexed emails only. Indexed Emails: {countData?.count ?? 0}</>
              : "\u00A0"}
          </p>
        </div>

        {/* Compose button */}
        <Button
          onClick={() => setComposeOpen(true)}
          className="shrink-0 gap-2"
        >
          <PencilIcon className="size-4" />
          Compose
        </Button>

        {/* Sync emails button */}
        <Button
          variant="outline"
          onClick={handleSync}
          disabled={syncing}
          className="shrink-0 gap-2"
        >
          <DownloadIcon className="size-4" />
          {syncing ? "Syncing…" : "Sync"}
        </Button>
        {countData && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            Imported: {countData.count}
          </span>
        )}

        {/* Generate Embeddings button */}
        <Button
          variant="outline"
          onClick={handleGenerateEmbeddings}
          disabled={embedding}
          className="shrink-0 gap-2"
        >
          <SparklesIcon className="size-4" />
          {embedding
            ? "Embedding…"
            : `Generate Embeddings${pendingData ? ` (${pendingData.pending} pending)` : ""}`}
        </Button>

        {/* Dobbie AI Assistant button */}
        <Button
          variant="default"
          onClick={() => router.push("/assistant")}
          className="shrink-0 gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
        >
          <BotIcon className="size-4" />
          Dobbie
        </Button>

        {/* Calendar button */}
        <Button
          variant="outline"
          onClick={() => router.push("/calendar")}
          className="shrink-0 gap-2"
        >
          <CalendarDaysIcon className="size-4" />
          Calendar
        </Button>

        {/* Logout button */}
        <Button
          variant="ghost"
          onClick={handleLogout}
          className="shrink-0"
        >
          <LogOutIcon className="size-4" />
          Logout
        </Button>
      </div>

      <ComposeDialog open={composeOpen} onOpenChange={setComposeOpen} />

      {children}
    </div>
  );
}
