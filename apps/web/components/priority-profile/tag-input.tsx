"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { Input } from "@web/components/ui/input";
import { Badge } from "@web/components/ui/badge";

// Chip-style free-text input. Every entry passes through `sanitize` before
// it can join the list — invalid text shows an inline error and never enters
// form state, so raw user text can't reach the API or DB.
export function TagInput({
  value,
  onChange,
  sanitize,
  placeholder,
  max = 20,
  invalidMessage = "That doesn't look valid",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  sanitize: (raw: string) => string | null;
  placeholder?: string;
  max?: number;
  invalidMessage?: string;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    if (!draft.trim()) return;
    const cleaned = sanitize(draft);
    if (!cleaned) {
      setError(invalidMessage);
      return;
    }
    if (value.some((v) => v.toLowerCase() === cleaned.toLowerCase())) {
      setDraft("");
      setError(null);
      return;
    }
    if (value.length >= max) {
      setError(`Maximum ${max} entries`);
      return;
    }
    onChange([...value, cleaned]);
    setDraft("");
    setError(null);
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              {tag}
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                onClick={() => onChange(value.filter((v) => v !== tag))}
                className="rounded-full p-0.5 hover:bg-muted-foreground/20"
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
