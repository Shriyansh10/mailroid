"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LogOutIcon, PencilIcon, SearchIcon, XIcon, CalendarDaysIcon, BotIcon, DownloadIcon, SparklesIcon, InboxIcon, SendIcon } from "lucide-react";
import { Input } from "@web/components/ui/input";
import { Button } from "@web/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@web/components/ui/avatar";
import { ComposeDialog } from "@web/components/inbox/compose-dialog";
import { authClient, useSession } from "@web/lib/auth-client";
import { useSyncEmails, useStoredEmailCount, useGenerateEmbeddings, usePendingEmbeddingsCount, useCategoryCounts } from "@web/hooks/api/gmail";
import { frontendLogger } from "@web/lib/frontend-logger";

const DEBOUNCE_MS = 300;

type SearchMode = "gmail" | "ai";

const INBOX_CATEGORIES = [
  { key: "PRIMARY", label: "Primary" },
  { key: "PROMOTIONS", label: "Promotions" },
  { key: "SOCIAL", label: "Social" },
  { key: "FORUMS", label: "Forums" },
] as const;

function getInitials(name: string): string {
  return name.split(/\s+/).filter((p) => p.length > 0).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const category = searchParams.get("category") ?? "PRIMARY";
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
  const { data: categoryCounts } = useCategoryCounts();

  const initials = useMemo(() => {
    const name = session?.user?.name;
    return name ? getInitials(name) : "?";
  }, [session?.user?.name]);

  const avatarUrl = session?.user?.image ?? null;

  useEffect(() => { setLocalValue(currentQuery); }, [currentQuery]);

  const navigateTo = (params: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v) p.set(k, v); else p.delete(k);
    }
    frontendLogger.info("[INBOX_UI]", "navigateTo", { params, url: `/inbox${p.size ? `?${p.toString()}` : ""}` });
    router.replace(`/inbox${p.size ? `?${p.toString()}` : ""}`);
  };

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setLocalValue(value);
    frontendLogger.info("[INBOX_UI]", "search input change", { value, searchMode, category });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      frontendLogger.info("[INBOX_UI]", "search debounce fired", { value, searchMode, category });
      if (searchMode === "ai") {
        navigateTo({ category, aiq: value || undefined, mode: "ai" });
      } else {
        navigateTo({ category, q: value || undefined, mode: value ? "gmail" : undefined });
      }
    }, DEBOUNCE_MS);
  }, [category, searchMode]);

  const handleLogout = useCallback(async () => {
    await authClient.signOut();
    router.push("/sign-in");
  }, [router]);

  const handleSync = useCallback(async () => {
    frontendLogger.info("[INBOX_UI]", "sync button clicked", { storedCount: countData?.count });
    const result = await syncEmailsAsync();
    refetchCount(); refetchPending();
    frontendLogger.info("[INBOX_UI]", "sync completed", { synced: result.synced });
  }, [syncEmailsAsync, refetchCount, refetchPending]);

  const handleGenerateEmbeddings = useCallback(async () => {
    frontendLogger.info("[INBOX_UI]", "embed button clicked");
    const result = await generateEmbeddingsAsync();
    refetchPending();
    frontendLogger.info("[INBOX_UI]", "embedding completed", { embedded: result.embedded });
  }, [generateEmbeddingsAsync, refetchPending]);

  const count = (cat: string) => categoryCounts?.[cat] ?? 0;

  return (
    <div className="flex h-screen">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <div className="w-56 shrink-0 border-r bg-muted/30 flex flex-col px-3 py-4 gap-1">
        <button
          onClick={() => navigateTo({ category: "PRIMARY", q: undefined })}
          className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
            category === "PRIMARY" || INBOX_CATEGORIES.some((c) => c.key === category)
              ? "bg-accent"
              : "hover:bg-accent/50"
          }`}
        >
          <InboxIcon className="size-4" />
          <span className="flex-1 text-left">Inbox</span>
        </button>

        {INBOX_CATEGORIES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => navigateTo({ category: key, q: undefined })}
            className={`flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm pl-10 transition-colors ${
              category === key ? "bg-accent font-semibold" : "hover:bg-accent/50 text-muted-foreground"
            }`}
          >
            <span className="flex-1 text-left">{label}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{count(key)}</span>
          </button>
        ))}

        <div className="mt-3 mb-1 border-t" />

        <button
          onClick={() => navigateTo({ category: "SENT", q: undefined })}
          className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
            category === "SENT" ? "bg-accent font-semibold" : "hover:bg-accent/50 text-muted-foreground"
          }`}
        >
          <SendIcon className="size-4" />
          <span className="flex-1 text-left">Sent</span>
          <span className="text-xs text-muted-foreground tabular-nums">{count("SENT")}</span>
        </button>
      </div>

      {/* ── Main area ───────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-6 py-3 border-b">
          <Avatar className="size-8 shrink-0 ring-2 ring-chart-1/50">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={session?.user?.name ?? "User"} />}
            <AvatarFallback className="bg-chart-1 text-primary-foreground text-xs font-semibold">{initials}</AvatarFallback>
          </Avatar>

          <div className="flex items-center gap-2 flex-1 max-w-2xl">
            <div className="inline-flex rounded-lg border bg-muted p-0.5 shrink-0">
              <button
                onClick={() => { frontendLogger.info("[INBOX_UI]", "search mode gmail clicked", { category }); navigateTo({ category, q: undefined, mode: undefined }); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  searchMode === "gmail"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Search Gmail
              </button>
              <button
                onClick={() => { frontendLogger.info("[INBOX_UI]", "search mode ai clicked", { category }); navigateTo({ category, aiq: undefined, mode: "ai" }); }}
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
                placeholder={searchMode === "gmail" ? "Search your entire Gmail account…" : "Ask Dobbie about your emails…"}
                value={localValue}
                onChange={handleChange}
                className="pl-9 pr-9"
              />
              {localValue && (
                <button
                  onClick={() => { frontendLogger.info("[INBOX_UI]", "search cleared", { category, searchMode }); setLocalValue(""); navigateTo({ category, q: undefined, aiq: undefined }); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted"
                >
                  <XIcon className="size-4" />
                </button>
              )}
            </div>
          </div>

          <Button onClick={() => setComposeOpen(true)} className="gap-1.5"><PencilIcon className="size-4" />Compose</Button>
          <Button variant="outline" onClick={handleSync} disabled={syncing} className="gap-1.5"><DownloadIcon className="size-4" />{syncing ? "Syncing…" : "Sync"}</Button>
          {countData && <span className="text-xs text-muted-foreground whitespace-nowrap">Imported: {countData.count}</span>}
          <Button variant="outline" onClick={handleGenerateEmbeddings} disabled={embedding} className="gap-1.5"><SparklesIcon className="size-4" />{embedding ? "Embedding…" : "Embed"}</Button>
          <Button onClick={() => router.push("/assistant")} className="gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white"><BotIcon className="size-4" />Dobbie</Button>
          <Button variant="outline" onClick={() => router.push("/calendar")} className="gap-1.5"><CalendarDaysIcon className="size-4" />Calendar</Button>
          <Button variant="ghost" onClick={handleLogout}><LogOutIcon className="size-4" /></Button>
        </div>

        <ComposeDialog open={composeOpen} onOpenChange={setComposeOpen} />
        <div className="flex-1 overflow-auto px-6 py-4">{children}</div>
      </div>
    </div>
  );
}
