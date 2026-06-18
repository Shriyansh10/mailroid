"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LogOutIcon, PencilIcon, SearchIcon, XIcon, CalendarDaysIcon, BotIcon, DownloadIcon, SparklesIcon, InboxIcon, SendIcon } from "lucide-react";
import Image from "next/image";
import { 
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, 
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger 
} from "@web/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader,
  DialogTitle, DialogTrigger,
} from "@web/components/ui/dialog";
import { SettingsIcon, KeyboardIcon, CheckCircle2, RefreshCwIcon } from "lucide-react";
import logoImg from "../../../assets/Logo/mailroid-no-background.png";

import { Input } from "@web/components/ui/input";
import { Button } from "@web/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@web/components/ui/avatar";
import { ComposeDialog } from "@web/components/inbox/compose-dialog";
import { authClient, useSession } from "@web/lib/auth-client";
import { useSyncEmails, useStoredEmailCount, useGenerateEmbeddings, usePendingEmbeddingsCount, useCategoryCounts } from "@web/hooks/api/gmail";
import { frontendLogger } from "@web/lib/frontend-logger";
import { DailyUsageWidget } from "@web/components/DailyUsageWidget";

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
    <div className="flex h-screen bg-background text-foreground">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <div className="w-64 shrink-0 border-r bg-muted/10 flex flex-col px-4 py-6 gap-1 overflow-y-auto">
        {/* Sidebar Logo Area */}
        <div className="flex items-center gap-3 px-2 mb-6">
          <Image src={logoImg} alt="Mailroid" className="h-8 w-8 object-contain" />
          <span className="font-semibold tracking-tight text-lg">Mailroid</span>
        </div>

        {/* Compose */}
        <Button onClick={() => setComposeOpen(true)} className="w-full justify-start gap-2 h-11 font-medium shadow-sm mb-4">
          <PencilIcon className="size-4" />
          Compose
        </Button>

        {/* Navigation section 1 */}
        <div className="space-y-0.5">
          <button
            onClick={() => navigateTo({ category: "PRIMARY", q: undefined })}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              category === "PRIMARY" || (!["PRIORITY", "SENT"].includes(category) && !INBOX_CATEGORIES.some(c => c.key === category))
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <InboxIcon className="size-4" />
            <span className="flex-1 text-left">Inbox</span>
          </button>

          <button
            onClick={() => navigateTo({ category: "PRIORITY", q: undefined })}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              category === "PRIORITY" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <SparklesIcon className="size-4" />
            <span className="flex-1 text-left">Priority</span>
          </button>

          {/* Inbox Sub-categories */}
          <div className="mt-1 mb-2 space-y-0.5">
            {INBOX_CATEGORIES.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => navigateTo({ category: key, q: undefined })}
                className={`w-full flex items-center gap-3 px-3 py-1.5 rounded-lg text-sm pl-10 transition-colors ${
                  category === key ? "text-foreground font-medium bg-accent/40" : "hover:bg-accent/30 text-muted-foreground"
                }`}
              >
                <span className="flex-1 text-left">{label}</span>
                <span className="text-xs text-muted-foreground opacity-60 tabular-nums">{count(key)}</span>
              </button>
            ))}
          </div>

          <button
            onClick={() => navigateTo({ category: "SENT", q: undefined })}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              category === "SENT" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <SendIcon className="size-4" />
            <span className="flex-1 text-left">Sent</span>
            <span className="text-xs text-muted-foreground opacity-60 tabular-nums">{count("SENT")}</span>
          </button>
        </div>

        <div className="my-3 border-t border-border/40" />

        {/* Navigation section 2 */}
        <div className="space-y-0.5">
          <button
            onClick={() => router.push("/calendar")}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <CalendarDaysIcon className="size-4" />
            <span className="flex-1 text-left">Calendar</span>
          </button>

          <button
            onClick={() => router.push("/assistant")}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-indigo-500/10 text-indigo-600 hover:bg-indigo-500/15"
          >
            <BotIcon className="size-4" />
            <span className="flex-1 text-left">Dobbie</span>
          </button>
        </div>

        <div className="my-3 border-t border-border/40" />

        

        <div className="flex-grow" />

        {/* Usage Widget */}
        <div className="mt-auto pt-4 border-t border-border/40">
          <DailyUsageWidget />
        </div>
      </div>

      {/* ── Main area ───────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        {/* Top bar */}
        <div className="flex items-center gap-4 px-8 py-3 h-16 border-b border-border/40 shrink-0 w-full">
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border bg-muted p-0.5 shrink-0">
              <button
                onClick={() => { navigateTo({ category, q: undefined, mode: undefined }); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  searchMode === "gmail"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Search Gmail
              </button>
              <button
                onClick={() => { navigateTo({ category, aiq: undefined, mode: "ai" }); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  searchMode === "ai"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Ask Dobbie
              </button>
            </div>
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="relative w-full">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                type="text"
                placeholder={searchMode === "gmail" ? "Search your workspace..." : "Ask Dobbie about your emails…"}
                value={localValue}
                onChange={handleChange}
                className="pl-10 pr-10 w-full bg-transparent border-border text-muted-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:border-input transition-colors shadow-sm"
              />
              {localValue && (
                <button
                  onClick={() => { setLocalValue(""); navigateTo({ category, q: undefined, aiq: undefined }); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded-full hover:bg-muted"
                >
                  <XIcon className="size-4" />
                </button>
              )}
            </div>
          </div>


          <div className="flex items-center gap-3 mr-4">
            <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing} className="gap-1.5 text-xs h-8">
              <DownloadIcon className="size-3.5" />{syncing ? "Syncing…" : "Sync"}
            </Button>
            {countData && <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider whitespace-nowrap">Imported: {countData.count}</span>}
            <Button variant="outline" size="sm" onClick={handleGenerateEmbeddings} disabled={embedding} className="gap-1.5 text-xs h-8">
              <SparklesIcon className="size-3.5" />{embedding ? "Embedding…" : "Embed"}
            </Button>
            {pendingData !== undefined && <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider whitespace-nowrap">Pending: {pendingData.pending}</span>}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded-full ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 hover:opacity-80">
                <Avatar className="size-9 border border-border/50 shadow-sm">
                  {avatarUrl && <AvatarImage src={avatarUrl} alt={session?.user?.name ?? "User"} />}
                  <AvatarFallback className="bg-muted text-foreground text-xs font-semibold">{initials}</AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 mt-1 shadow-md">
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">{session?.user?.name ?? "User"}</p>
                  <p className="text-xs leading-none text-muted-foreground">{session?.user?.email ?? ""}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="cursor-pointer" onClick={() => router.push("/settings")}>
                <SettingsIcon className="mr-2 h-4 w-4" />
                <span>Settings</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer" onClick={() => router.push("/settings/shortcuts")}>
                <KeyboardIcon className="mr-2 h-4 w-4" />
                <span>Keyboard Shortcuts</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="cursor-pointer text-red-600 focus:text-red-600" onClick={handleLogout}>
                <LogOutIcon className="mr-2 h-4 w-4" />
                <span>Sign Out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <ComposeDialog open={composeOpen} onOpenChange={setComposeOpen} />
        
        <div className="flex-1 overflow-auto bg-background">{children}</div>
      </div>
    </div>
  );
}

