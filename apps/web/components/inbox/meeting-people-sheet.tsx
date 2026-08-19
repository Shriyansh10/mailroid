"use client";

import { useMemo, useState } from "react";
import { SearchIcon, UserIcon } from "lucide-react";

import { Input } from "@web/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@web/components/ui/sheet";
import { cn } from "@web/lib/utils";

/**
 * The full people list for a meeting, searchable.
 *
 * Exists because the card can only ever show the first few addresses before it
 * stops being a card. Past that the question changes from "who is on this?" to
 * "is *this person* on this?", and scrolling a long list is a bad way to answer
 * it — hence a filter rather than just a taller box.
 *
 * Deliberately one component for both roles. The host list is length 1 today
 * (Google Calendar events have exactly one organizer, and co-hosts have no
 * representation in the Calendar API), so it never actually opens this — but
 * the shape is the same if that ever changes, and one component means the two
 * lists cannot drift apart in how they render or filter.
 */
export function MeetingPeopleSheet({
  open,
  onOpenChange,
  title,
  description,
  people,
  organizerEmail,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  people: string[];
  /** Marked in the list when present, so "who runs this" needs no second look. */
  organizerEmail?: string;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((email) => email.toLowerCase().includes(q));
  }, [people, query]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col gap-0 p-0 sm:max-w-sm">
        {/* pr-10 clears the Sheet's absolutely-positioned close button, which
            sits at top-4 right-4 and would otherwise land on the title. */}
        <SheetHeader className="border-b pr-10">
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>

        <div className="border-b p-4">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by email…"
              className="h-8 pl-8 text-xs"
              autoFocus
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {filtered.length === 0 ? (
            // Says which of the two empty states this is. "No results" on a
            // list that was never populated would be a different problem
            // wearing the same words.
            <p className="text-xs text-muted-foreground">
              {people.length === 0
                ? "Nobody is on this list."
                : `No match for “${query.trim()}”.`}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {filtered.map((email) => {
                const isOrganizer =
                  !!organizerEmail &&
                  email.toLowerCase() === organizerEmail.toLowerCase();
                return (
                  <li
                    key={email}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                      isOrganizer && "bg-accent/50",
                    )}
                  >
                    <UserIcon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 font-mono break-all">
                      {email}
                    </span>
                    {isOrganizer && (
                      <span className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        Host
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t px-4 py-2.5 text-[11px] text-muted-foreground">
          {query.trim()
            ? `${filtered.length} of ${people.length}`
            : `${people.length} ${people.length === 1 ? "person" : "people"}`}
        </div>
      </SheetContent>
    </Sheet>
  );
}
