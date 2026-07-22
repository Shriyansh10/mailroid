"use client";

import { cn } from "@web/lib/utils";

// Toggleable enum chips with an optional max — the generic multi-select
// used for goals, sender categories, focus items, email types and services.
export function ChipMultiSelect<T extends string>({
  options,
  value,
  onChange,
  max,
}: {
  options: { value: T; label: string }[];
  value: T[];
  onChange: (next: T[]) => void;
  max?: number;
}) {
  const toggle = (v: T) => {
    if (value.includes(v)) {
      onChange(value.filter((x) => x !== v));
      return;
    }
    if (max !== undefined && value.length >= max) return;
    onChange([...value, v]);
  };

  const atMax = max !== undefined && value.length >= max;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const selected = value.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={selected}
              onClick={() => toggle(opt.value)}
              disabled={!selected && atMax}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card text-foreground/80 hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {max !== undefined && (
        <p className="text-xs text-muted-foreground">
          {value.length} / {max} selected
        </p>
      )}
    </div>
  );
}
