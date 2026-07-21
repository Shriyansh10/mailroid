"use client";

import React, { useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, ChevronDownIcon } from "lucide-react";

import { Button } from "@web/components/ui/button";
import { Calendar } from "@web/components/ui/calendar";
import { Input } from "@web/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@web/components/ui/popover";
import { cn } from "@web/lib/utils";
import {
  buildDurationOptions,
  buildTimeOptions,
  combineDateAndTime,
  formatDuration,
  parseDurationInput,
  parseTimeInput,
} from "./event-form-utils";

// ── Combo input: type freely, or pick from the list ──────────────────

interface ComboInputProps {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: number; label: string }[];
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}

function ComboInput({
  id,
  value,
  onChange,
  options,
  placeholder,
  invalid,
  disabled,
  "aria-label": ariaLabel,
}: ComboInputProps) {
  const [open, setOpen] = useState(false);

  // Filter as the user types, but never show an empty list — the typed value is
  // authoritative, the list is only a shortcut.
  const filtered = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query) return options;
    const hits = options.filter((o) => o.label.toLowerCase().includes(query));
    return hits.length > 0 ? hits : options;
  }, [value, options]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Anchor on the whole field so the list matches the input's width. */}
      <PopoverAnchor className="relative">
        <Input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={invalid}
          autoComplete="off"
          className="pr-8"
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />
        <PopoverTrigger asChild>
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label={`Show ${ariaLabel ?? "options"}`}
            className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-8 items-center justify-center"
          >
            <ChevronDownIcon className="size-4" />
          </button>
        </PopoverTrigger>
      </PopoverAnchor>

      <PopoverContent
        align="start"
        className="max-h-56 w-(--radix-popover-trigger-width) min-w-32 overflow-y-auto p-1"
        // Keep the caret in the input so typing continues to filter.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {filtered.map((option) => (
          <button
            key={option.value}
            type="button"
            className="hover:bg-accent hover:text-accent-foreground w-full rounded-sm px-2 py-1.5 text-left text-sm"
            onClick={() => {
              onChange(option.label);
              setOpen(false);
            }}
          >
            {option.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// ── Date + time + duration row ───────────────────────────────────────

interface DateTimeFieldsProps {
  date: Date | undefined;
  onDateChange: (next: Date) => void;
  startTime: string;
  onStartTimeChange: (next: string) => void;
  duration: string;
  onDurationChange: (next: string) => void;
  days: string;
  onDaysChange: (next: string) => void;
  allDay: boolean;
  errors?: {
    date?: string;
    startTime?: string;
    duration?: string;
    days?: string;
  };
  disabled?: boolean;
}

export function DateTimeFields({
  date,
  onDateChange,
  startTime,
  onStartTimeChange,
  duration,
  onDurationChange,
  days,
  onDaysChange,
  allDay,
  errors,
  disabled,
}: DateTimeFieldsProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);

  const timeOptions = useMemo(() => buildTimeOptions(), []);
  const durationOptions = useMemo(() => buildDurationOptions(), []);

  // The derived end, shown read-only so the user always sees what they get
  // without ever typing a second date.
  const endsLabel = useMemo(() => {
    if (!date) return null;

    if (allDay) {
      const dayCount = Number(days);
      if (!Number.isInteger(dayCount) || dayCount < 1) return null;
      return dayCount === 1
        ? `All day on ${format(date, "EEE, MMM d")}`
        : `${dayCount} days, through ${format(
            new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayCount - 1),
            "EEE, MMM d",
          )}`;
    }

    const minutesOfDay = parseTimeInput(startTime);
    const durationMinutes = parseDurationInput(duration);
    if (minutesOfDay === null || durationMinutes === null) return null;

    const start = combineDateAndTime(date, minutesOfDay);
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    const sameDay = start.toDateString() === end.toDateString();

    return `Ends ${format(end, sameDay ? "h:mm a" : "EEE, MMM d · h:mm a")} · ${formatDuration(
      durationMinutes,
    )}`;
  }, [date, allDay, days, startTime, duration]);

  return (
    <div className="space-y-2">
      <div className={cn("grid gap-2", allDay ? "grid-cols-[1fr_9rem]" : "grid-cols-[1fr_8rem_9rem]")}>
        {/* Date */}
        <div>
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                aria-invalid={!!errors?.date}
                className={cn(
                  "w-full justify-start gap-2 font-normal",
                  !date && "text-muted-foreground",
                )}
              >
                <CalendarIcon className="size-4 shrink-0" />
                {date ? format(date, "EEE, MMM d, yyyy") : "Pick a date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-0">
              <Calendar
                mode="single"
                selected={date}
                defaultMonth={date}
                autoFocus
                onSelect={(next) => {
                  if (!next) return;
                  onDateChange(next);
                  setCalendarOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>

        {allDay ? (
          /* Days */
          <div>
            <Input
              value={days}
              disabled={disabled}
              inputMode="numeric"
              aria-label="Number of days"
              aria-invalid={!!errors?.days}
              onChange={(e) => onDaysChange(e.target.value)}
            />
          </div>
        ) : (
          <>
            {/* Start time */}
            <ComboInput
              value={startTime}
              onChange={onStartTimeChange}
              options={timeOptions}
              placeholder="2:30 PM"
              aria-label="Start time"
              invalid={!!errors?.startTime}
              disabled={disabled}
            />

            {/* Duration */}
            <ComboInput
              value={duration}
              onChange={onDurationChange}
              options={durationOptions}
              placeholder="1 hr"
              aria-label="Duration"
              invalid={!!errors?.duration}
              disabled={disabled}
            />
          </>
        )}
      </div>

      {errors?.date || errors?.startTime || errors?.duration || errors?.days ? (
        <p className="text-destructive text-xs">
          {errors.date ?? errors.startTime ?? errors.duration ?? errors.days}
        </p>
      ) : endsLabel ? (
        <p className="text-muted-foreground text-xs">{endsLabel}</p>
      ) : null}
    </div>
  );
}
