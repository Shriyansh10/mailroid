"use client";

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import logoImg from "../../../assets/Logo/mailroid-no-background.png";
import { 
  LogOutIcon, PencilIcon, CalendarDaysIcon, 
  BotIcon, SparklesIcon, InboxIcon, SendIcon,
  KeyboardIcon, PaletteIcon
} from "lucide-react";
import { 
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, 
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger 
} from "@web/components/ui/dropdown-menu";
import { Button } from "@web/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@web/components/ui/avatar";
import { ComposeDialog } from "@web/components/inbox/compose-dialog";
import { authClient, useSession } from "@web/lib/auth-client";
import { DailyUsageWidget } from "@web/components/DailyUsageWidget";

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter((p) => p.length > 0)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export default function CalendarLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [composeOpen, setComposeOpen] = useState(false);
  const { data: session } = useSession();

  const initials = useMemo(() => {
    const name = session?.user?.name;
    return name ? getInitials(name) : "?";
  }, [session?.user?.name]);

  const avatarUrl = session?.user?.image ?? null;

  const handleLogout = useCallback(async () => {
    await authClient.signOut();
    router.push("/sign-in");
  }, [router]);

  // "c" to compose, mirroring the inbox shortcut (documented at /settings/shortcuts).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (composeOpen || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const isTyping = target && (
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
      );
      if (isTyping) return;
      if (e.key === "c") {
        e.preventDefault();
        setComposeOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composeOpen]);

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* ── Main Sidebar ─────────────────────────────────────────── */}
      <div className="w-64 shrink-0 border-r bg-muted/10 flex flex-col px-4 py-6 gap-1 overflow-y-auto">
        {/* Logo */}
        <div className="flex items-center gap-3 px-2 mb-6 select-none">
          <Image src={logoImg} alt="Mailroid" className="h-8 w-8 object-contain" />
          <span className="font-semibold tracking-tight text-lg">Mailroid</span>
        </div>

        {/* Compose */}
        <Button onClick={() => setComposeOpen(true)} className="w-full justify-start gap-2 h-11 font-medium shadow-sm mb-4">
          <PencilIcon className="size-4" />
          Compose
        </Button>

        {/* Navigation Section */}
        <div className="space-y-0.5">
          <button
            onClick={() => router.push("/inbox")}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <InboxIcon className="size-4" />
            <span className="flex-1 text-left">Inbox</span>
          </button>

          <button
            onClick={() => router.push("/inbox?category=PRIORITY")}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <SparklesIcon className="size-4" />
            <span className="flex-1 text-left">Priority</span>
          </button>

          <button
            onClick={() => router.push("/inbox?category=SENT")}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors animate-none"
          >
            <SendIcon className="size-4" />
            <span className="flex-1 text-left">Sent</span>
          </button>
        </div>

        <div className="my-3 border-t border-border/40" />

        {/* Calendar & Assistant */}
        <div className="space-y-0.5">
          <button
            onClick={() => router.push("/calendar")}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium bg-accent text-foreground transition-colors"
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

        <div className="flex-grow" />

        {/* Daily Usage */}
        <div className="mt-auto pt-4 border-t border-border/40">
          <DailyUsageWidget />
        </div>
      </div>

      {/* ── Main View Panel ──────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">
        {/* Top Header Strip */}
        <div className="flex items-center justify-end px-8 py-3 h-16 border-b border-border/40 shrink-0 w-full">
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
              <DropdownMenuItem className="cursor-pointer" onClick={() => router.push("/settings/personalization")}>
                <SparklesIcon className="mr-2 h-4 w-4" />
                <span>Personalization</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer" onClick={() => router.push("/settings/appearance")}>
                <PaletteIcon className="mr-2 h-4 w-4" />
                <span>Appearance</span>
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
