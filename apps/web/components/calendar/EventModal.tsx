"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trash2Icon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import { Switch } from "@web/components/ui/switch";
import { Textarea } from "@web/components/ui/textarea";
import { GuestInput } from "./GuestInput";
import { DateTimeFields } from "./DateTimeFields";
import {
  allDayEndKey,
  allDaySpanInDays,
  combineDateAndTime,
  formatDuration,
  formatTimeOfDay,
  parseDurationInput,
  parseLocalDateKey,
  parseTimeInput,
  sanitizeText,
  toLocalDateKey,
} from "./event-form-utils";

interface EventModalProps {
  isOpen: boolean;
  mode: "create" | "edit";
  initialData?: {
    id?: string;
    title?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
    attendees?: string[];
    allDay?: boolean;
  };
  onSave: (data: {
    id?: string;
    title: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
    allDay?: boolean;
  }) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}

// ── Schema ───────────────────────────────────────────────────────────
//
// Times and durations are kept as the raw text the user typed so the fields
// stay freely editable; they are parsed and validated here, then converted in
// onSubmit. No transforms, so the form's input and output types match.

const formSchema = z
  .object({
    title: z.string(),
    date: z.date(),
    startTime: z.string(),
    duration: z.string(),
    allDay: z.boolean(),
    days: z.string(),
    attendees: z.array(z.email()).max(50),
    location: z.string(),
    description: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.allDay) {
      const days = Number(data.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        ctx.addIssue({
          code: "custom",
          path: ["days"],
          message: "Enter a whole number of days between 1 and 365",
        });
      }
      return;
    }

    const minutesOfDay = parseTimeInput(data.startTime);
    if (minutesOfDay === null) {
      ctx.addIssue({
        code: "custom",
        path: ["startTime"],
        message: "Enter a time like 2:30 PM or 14:30",
      });
    }

    const durationMinutes = parseDurationInput(data.duration);
    if (durationMinutes === null) {
      ctx.addIssue({
        code: "custom",
        path: ["duration"],
        message: "Enter a duration like 30m, 1h 30m, or 90",
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

// ── Defaults & seeding ───────────────────────────────────────────────

function nextHour(): { date: Date; minutesOfDay: number } {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 1);
  return { date: now, minutesOfDay: now.getHours() * 60 };
}

/**
 * Derive form values from whatever the calendar page handed us.
 *
 * All-day values are calendar dates: they are read straight off the
 * `yyyy-MM-dd` string and never passed through `new Date(str)`, which would
 * parse as UTC midnight and read back as the previous day west of UTC.
 */
function buildDefaults(initialData: EventModalProps["initialData"]): FormValues {
  const fallback = nextHour();
  const base: FormValues = {
    title: initialData?.title ?? "",
    date: fallback.date,
    startTime: formatTimeOfDay(fallback.minutesOfDay),
    duration: formatDuration(60),
    allDay: initialData?.allDay ?? false,
    days: "1",
    attendees: initialData?.attendees ?? [],
    location: initialData?.location ?? "",
    description: initialData?.description ?? "",
  };

  if (!initialData?.start) return base;

  if (base.allDay) {
    const startKey = initialData.start.slice(0, 10);
    const date = parseLocalDateKey(startKey);
    if (date) base.date = date;
    base.days = String(allDaySpanInDays(startKey, (initialData.end ?? "").slice(0, 10)));
    return base;
  }

  const start = new Date(initialData.start);
  if (Number.isNaN(start.getTime())) return base;

  base.date = start;
  base.startTime = formatTimeOfDay(start.getHours() * 60 + start.getMinutes());

  const end = initialData.end ? new Date(initialData.end) : null;
  if (end && !Number.isNaN(end.getTime())) {
    const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
    if (minutes >= 1) base.duration = formatDuration(minutes);
  }

  return base;
}

// ── Draft persistence ────────────────────────────────────────────────
//
// sessionStorage, not localStorage: the draft survives closing the modal and
// reloading the page, and dies with the tab.

const DRAFT_KEY = "mailroid:calendar:event-draft";

interface Draft {
  title: string;
  duration: string;
  days: string;
  attendees: string[];
  location: string;
  description: string;
}

function readDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

function writeDraft(draft: Draft) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* quota or private mode — a lost draft is not worth failing over */
  }
}

function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

/** Only the fields worth restoring count — defaults alone are not a draft. */
function hasContent(draft: Draft): boolean {
  return !!(
    draft.title.trim() ||
    draft.location.trim() ||
    draft.description.trim() ||
    draft.attendees.length
  );
}

// ── Component ────────────────────────────────────────────────────────

const COMMIT = { shouldValidate: true, shouldDirty: true } as const;

export default function EventModal({
  isOpen,
  mode,
  initialData,
  onSave,
  onDelete,
  onClose,
}: EventModalProps) {
  const [draftRestored, setDraftRestored] = useState(false);
  // Set on submit; the parent only closes the modal when the save succeeded, so
  // "closed while this is set" is our signal that the draft can go.
  const savedRef = useRef(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: buildDefaults(undefined),
  });

  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = form;

  const [allDay, date, startTime, duration, days] = watch([
    "allDay",
    "date",
    "startTime",
    "duration",
    "days",
  ]);

  // Write-through setters for the date/time controls. `shouldValidate` means an
  // error clears as soon as the user fixes the field.
  const setDate = useCallback((v: Date) => setValue("date", v, COMMIT), [setValue]);
  const setStartTime = useCallback(
    (v: string) => setValue("startTime", v, COMMIT),
    [setValue],
  );
  const setDuration = useCallback(
    (v: string) => setValue("duration", v, COMMIT),
    [setValue],
  );
  const setDays = useCallback((v: string) => setValue("days", v, COMMIT), [setValue]);

  const applyDefaults = useCallback(() => {
    reset(buildDefaults(initialData));
    setDraftRestored(false);
  }, [reset, initialData]);

  // Seed on open. In create mode a stored draft supplies *what* the event is;
  // the date and time always come from initialData, because those reflect the
  // day or slot the user just clicked.
  useEffect(() => {
    if (!isOpen) return;
    savedRef.current = false;

    const base = buildDefaults(initialData);
    const draft = mode === "create" ? readDraft() : null;

    if (draft && hasContent(draft)) {
      reset({
        ...base,
        title: draft.title,
        duration: draft.duration || base.duration,
        days: draft.days || base.days,
        attendees: draft.attendees,
        location: draft.location,
        description: draft.description,
      });
      setDraftRestored(true);
    } else {
      reset(base);
      setDraftRestored(false);
    }
  }, [isOpen, initialData, mode, reset]);

  // Persist the draft as the user types.
  useEffect(() => {
    if (!isOpen || mode !== "create") return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const persist = () => {
      const values = getValues();
      const draft: Draft = {
        title: values.title,
        duration: values.duration,
        days: values.days,
        attendees: values.attendees,
        location: values.location,
        description: values.description,
      };
      if (hasContent(draft)) writeDraft(draft);
      else clearDraft();
    };

    const subscription = watch(() => {
      clearTimeout(timer);
      timer = setTimeout(persist, 300);
    });

    return () => {
      // Flush rather than drop: closing the modal within the debounce window is
      // exactly when the draft matters most.
      if (timer !== undefined) {
        clearTimeout(timer);
        persist();
      }
      subscription.unsubscribe();
    };
  }, [isOpen, mode, watch, getValues]);

  // Closed after a successful save — drop the draft. Closing any other way
  // (Escape, backdrop, X) deliberately keeps it.
  useEffect(() => {
    if (isOpen || !savedRef.current) return;
    savedRef.current = false;
    clearDraft();
  }, [isOpen]);

  const onSubmit = useCallback(
    (data: FormValues) => {
      let start: string;
      let end: string;

      if (data.allDay) {
        // Calendar dates, kept as local `yyyy-MM-dd`. Google's all-day end date
        // is exclusive, which is also how events read back from the API.
        start = toLocalDateKey(data.date);
        end = allDayEndKey(data.date, Number(data.days));
      } else {
        const minutesOfDay = parseTimeInput(data.startTime);
        const durationMinutes = parseDurationInput(data.duration);
        if (minutesOfDay === null || durationMinutes === null) return;

        const startDate = combineDateAndTime(data.date, minutesOfDay);
        const endDate = new Date(startDate.getTime() + durationMinutes * 60_000);
        start = startDate.toISOString();
        end = endDate.toISOString();
      }

      savedRef.current = true;
      onSave({
        id: initialData?.id,
        title: sanitizeText(data.title) || "(No title)",
        start,
        end,
        description: sanitizeText(data.description) || undefined,
        location: sanitizeText(data.location) || undefined,
        attendees: data.attendees.length > 0 ? data.attendees : undefined,
        allDay: data.allDay,
      });
    },
    [initialData?.id, onSave],
  );

  const handleCancel = useCallback(() => {
    clearDraft();
    setDraftRestored(false);
    onClose();
  }, [onClose]);

  const dateTimeErrors = useMemo(
    () => ({
      date: errors.date?.message,
      startTime: errors.startTime?.message,
      duration: errors.duration?.message,
      days: errors.days?.message,
    }),
    [errors.date, errors.startTime, errors.duration, errors.days],
  );

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        // Escape / backdrop / X: close but keep the draft.
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create Event" : "Edit Event"}</DialogTitle>
          <DialogDescription>
            {draftRestored ? (
              <span className="flex items-center gap-2">
                Draft restored.
                <button
                  type="button"
                  onClick={applyDefaults}
                  className="text-foreground underline underline-offset-2"
                >
                  Start over
                </button>
              </span>
            ) : mode === "create" ? (
              "Add an event to your calendar."
            ) : (
              "Update this event."
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          {/* Title */}
          <div className="grid gap-2">
            <Label htmlFor="event-title">Title</Label>
            <Input id="event-title" placeholder="Event title" autoFocus {...register("title")} />
          </div>

          {/* When */}
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>When</Label>
              <div className="flex items-center gap-2">
                <Label htmlFor="event-all-day" className="text-muted-foreground font-normal">
                  All day
                </Label>
                <Controller
                  control={control}
                  name="allDay"
                  render={({ field }) => (
                    <Switch
                      id="event-all-day"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </div>
            </div>

            <DateTimeFields
              date={date}
              onDateChange={setDate}
              startTime={startTime}
              onStartTimeChange={setStartTime}
              duration={duration}
              onDurationChange={setDuration}
              days={days}
              onDaysChange={setDays}
              allDay={allDay}
              errors={dateTimeErrors}
            />
          </div>

          {/* Guests */}
          <div className="grid gap-2">
            <Label htmlFor="event-guests">Guests</Label>
            <Controller
              control={control}
              name="attendees"
              render={({ field }) => (
                <GuestInput id="event-guests" value={field.value} onChange={field.onChange} />
              )}
            />
          </div>

          {/* Location */}
          <div className="grid gap-2">
            <Label htmlFor="event-location">Location</Label>
            <Input
              id="event-location"
              placeholder="Meeting room or link"
              {...register("location")}
            />
          </div>

          {/* Description */}
          <div className="grid gap-2">
            <Label htmlFor="event-description">Description</Label>
            <Textarea
              id="event-description"
              placeholder="Add description…"
              rows={3}
              {...register("description")}
            />
          </div>

          <DialogFooter className="sm:justify-between">
            <div>
              {mode === "edit" && onDelete && initialData?.id && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => onDelete(initialData.id!)}
                >
                  <Trash2Icon className="size-4" />
                  Delete
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button
                type="submit"
                className="bg-[#b08d57] text-white hover:bg-[#b08d57]/90"
              >
                {mode === "create" ? "Create" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
