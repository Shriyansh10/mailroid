"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LogOutIcon, PencilIcon, SearchIcon, XIcon } from "lucide-react";
import { Input } from "@web/components/ui/input";
import { Button } from "@web/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@web/components/ui/avatar";
import { ComposeDialog } from "@web/components/inbox/compose-dialog";
import { authClient, useSession } from "@web/lib/auth-client";

const DEBOUNCE_MS = 300;

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
  const currentQuery = searchParams.get("q") ?? "";
  const [localValue, setLocalValue] = useState(currentQuery);
  const [composeOpen, setComposeOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const { data: session } = useSession();

  const initials = useMemo(() => {
    const name = session?.user?.name;
    return name ? getInitials(name) : "?";
  }, [session?.user?.name]);

  const avatarUrl = session?.user?.image ?? null;

  // Keep local input in sync when URL changes externally (e.g. back/forward)
  useEffect(() => {
    setLocalValue(currentQuery);
  }, [currentQuery]);

  const pushQuery = useCallback(
    (q: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (q) {
        params.set("q", q);
        params.delete("page"); // reset page when search changes
      } else {
        params.delete("q");
        params.delete("page");
      }
      const path = params.size ? `/inbox?${params.toString()}` : "/inbox";
      router.replace(path);
    },
    [router, searchParams],
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

        {/* Search bar */}
        <div className="relative flex-1 max-w-lg">
        <SearchIcon
          className="
            absolute left-3 top-1/2 -translate-y-1/2
            size-4 text-muted-foreground pointer-events-none
          "
        />
        <Input
          type="text"
          placeholder="Search emails…"
          value={localValue}
          onChange={handleChange}
          className="pl-9 pr-9"
        />
        {localValue && (
          <button
            onClick={handleClear}
            aria-label="Clear search"
            className="
              absolute right-2 top-1/2 -translate-y-1/2
              p-1 flex items-center justify-center
              text-muted-foreground hover:text-foreground
              rounded-full hover:bg-muted transition-colors
            "
          >
            <XIcon className="size-4" />
          </button>
        )}
        </div>

        {/* Compose button */}
        <Button
          onClick={() => setComposeOpen(true)}
          className="shrink-0 gap-2"
        >
          <PencilIcon className="size-4" />
          Compose
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
