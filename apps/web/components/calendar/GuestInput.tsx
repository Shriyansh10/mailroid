"use client";

import React, { useCallback, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { z } from "zod";

import { Badge } from "@web/components/ui/badge";
import { cn } from "@web/lib/utils";
import { extractEmail } from "./event-form-utils";

const MAX_GUESTS = 50;

interface GuestInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  id?: string;
}

/**
 * Email chip input. Commits the pending token on Enter, comma, semicolon, Tab
 * and blur — all of them, so there is nothing to guess — and reports why a
 * rejected address was rejected instead of dropping it.
 */
export function GuestInput({ value, onChange, disabled, id }: GuestInputProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addGuests = useCallback(
    (raw: string): boolean => {
      const tokens = raw
        .split(/[,;\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (tokens.length === 0) return true;

      const next = [...value];
      for (const token of tokens) {
        const email = extractEmail(token);

        if (!z.email().safeParse(email).success) {
          setError(`"${token}" is not a valid email address`);
          return false;
        }
        if (next.includes(email)) {
          setError(`${email} is already added`);
          return false;
        }
        if (next.length >= MAX_GUESTS) {
          setError(`You can invite at most ${MAX_GUESTS} guests`);
          return false;
        }
        next.push(email);
      }

      setError(null);
      onChange(next);
      return true;
    },
    [value, onChange],
  );

  const commitDraft = useCallback((): boolean => {
    if (!draft.trim()) {
      setError(null);
      return true;
    }
    if (addGuests(draft)) {
      setDraft("");
      return true;
    }
    return false;
  }, [draft, addGuests]);

  const removeGuest = useCallback(
    (email: string) => {
      onChange(value.filter((g) => g !== email));
      setError(null);
    },
    [value, onChange],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      event.preventDefault();
      commitDraft();
      return;
    }

    if (event.key === "Tab" && draft.trim()) {
      // Commit, but only swallow the Tab if the address was accepted — an
      // invalid entry should keep focus so the message is visible.
      if (!commitDraft()) event.preventDefault();
      return;
    }

    if (event.key === "Backspace" && !draft && value.length > 0) {
      event.preventDefault();
      removeGuest(value[value.length - 1]!);
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!text) return;
    event.preventDefault();
    if (addGuests(`${draft}${text}`)) setDraft("");
  };

  return (
    <div>
      <div
        className={cn(
          "border-input dark:bg-input/30 flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border bg-transparent px-2 py-1.5 text-sm shadow-xs transition-[color,box-shadow]",
          "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
          error && "border-destructive ring-destructive/20 dark:ring-destructive/40",
          disabled && "pointer-events-none opacity-50",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((email) => (
          <Badge key={email} variant="secondary" className="gap-1 pr-1 font-normal">
            {email}
            <button
              type="button"
              aria-label={`Remove ${email}`}
              className="hover:bg-foreground/10 rounded-full p-0.5"
              onClick={(e) => {
                e.stopPropagation();
                removeGuest(email);
              }}
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        ))}

        <input
          ref={inputRef}
          id={id}
          type="text"
          value={draft}
          disabled={disabled}
          aria-invalid={!!error}
          placeholder={value.length === 0 ? "guest@example.com" : ""}
          className="placeholder:text-muted-foreground min-w-40 flex-1 bg-transparent outline-none"
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => commitDraft()}
        />
      </div>

      {error ? (
        <p className="text-destructive mt-1 text-xs">{error}</p>
      ) : (
        <p className="text-muted-foreground mt-1 text-xs">
          Press Enter or comma to add a guest.
        </p>
      )}
    </div>
  );
}
