"use client";

import { AlertTriangleIcon, CalendarClockIcon, RotateCcwIcon } from "lucide-react";
import { format } from "date-fns";

import { Switch } from "@web/components/ui/switch";
import { Label } from "@web/components/ui/label";
import { Input } from "@web/components/ui/input";
import { Textarea } from "@web/components/ui/textarea";
import { Button } from "@web/components/ui/button";
import { DateTimeFields } from "@web/components/calendar/DateTimeFields";
import {
  parseTimeInput,
  parseDurationInput,
  combineDateAndTime,
  formatTimeOfDay,
  formatDuration,
} from "@web/components/calendar/event-form-utils";

// ── Thread meeting shapes (mirror the tRPC output) ────────────────────

export interface ThreadMeeting {
  eventId: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  htmlLink?: string;
}

export interface ThreadMeetingRef {
  eventId: string;
  calendarId: string;
  title: string;
  start: string;
}

// ── Meeting state ─────────────────────────────────────────────────────

export interface MeetingState {
  enabled: boolean;
  date: Date | undefined;
  /** Raw text, parsed via parseTimeInput at build time. */
  startTime: string;
  /** Raw text, parsed via parseDurationInput at build time. */
  duration: string;
  location: string;
  description: string;
  /**
   * Whether sending moves the thread's existing meeting or creates another.
   * Defaults to "update" the moment a live meeting is found, so the common
   * case — "let's push it to 6" — costs zero clicks. The escape hatch is a
   * visible link, not a question asked every time.
   */
  mode: "create" | "update";
  /** The event `mode: "update"` will move. Set alongside mode. */
  target?: { calendarId: string; eventId: string };
}

/** The event input shape accepted by useCreateEvent().createEventAsync. */
export interface MeetingEventInput {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
}

/**
 * What the caller should do with the meeting fields. Discriminated so a caller
 * can't accidentally create when it meant to move — the eventId only exists on
 * the update branch.
 */
export type MeetingAction =
  | { kind: "create"; input: MeetingEventInput }
  | {
      kind: "update";
      calendarId: string;
      eventId: string;
      input: MeetingEventInput;
    };

function nextHour(): { date: Date; startTime: string } {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 1);
  return { date: now, startTime: formatTimeOfDay(now.getHours() * 60) };
}

export function emptyMeetingState(): MeetingState {
  const { date, startTime } = nextHour();
  return {
    enabled: false,
    date,
    startTime,
    duration: formatDuration(60),
    location: "",
    description: "",
    mode: "create",
  };
}

/**
 * Seed the fields from an existing meeting so the user edits the real thing
 * rather than re-entering it. Keeps `enabled` from the current state — finding
 * a meeting shouldn't switch the invite on by itself.
 */
export function meetingStateFromExisting(
  base: MeetingState,
  meeting: ThreadMeeting,
): MeetingState {
  const start = new Date(meeting.start);
  const end = new Date(meeting.end);
  const durationMinutes = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / 60_000),
  );

  return {
    ...base,
    date: start,
    startTime: formatTimeOfDay(start.getHours() * 60 + start.getMinutes()),
    duration: formatDuration(durationMinutes),
    mode: "update",
    target: { calendarId: meeting.calendarId, eventId: meeting.eventId },
  };
}

/** Seed meeting fields from a template's stored defaults (enabled). */
export function meetingStateFromTemplate(t: {
  meetingDurationMinutes: number | null;
  meetingLocation: string | null;
  meetingDescription: string | null;
}): MeetingState {
  const base = emptyMeetingState();
  return {
    ...base,
    enabled: true,
    duration: t.meetingDurationMinutes
      ? formatDuration(t.meetingDurationMinutes)
      : base.duration,
    location: t.meetingLocation ?? "",
    description: t.meetingDescription ?? "",
  };
}

/**
 * Build the calendar action from the current state, or null if the meeting is
 * disabled or the date/time/duration don't parse. Pure — the caller supplies
 * the title and attendees it owns.
 *
 * Returns a discriminated action rather than a bare input: when the thread
 * already has a meeting the correct behaviour is to *move* it, and a caller
 * that can only see an input would have no way to express that.
 */
export function buildEventInput(
  state: MeetingState,
  title: string,
  attendees: string[],
): MeetingAction | null {
  if (!state.enabled || !state.date) return null;
  const minutesOfDay = parseTimeInput(state.startTime);
  const durationMinutes = parseDurationInput(state.duration);
  if (minutesOfDay === null || durationMinutes === null) return null;

  const start = combineDateAndTime(state.date, minutesOfDay);
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  const input: MeetingEventInput = {
    title: title.trim() || "Meeting",
    start: start.toISOString(),
    end: end.toISOString(),
    ...(state.description.trim() ? { description: state.description.trim() } : {}),
    ...(state.location.trim() ? { location: state.location.trim() } : {}),
    ...(attendees.length > 0 ? { attendees } : {}),
  };

  if (state.mode === "update" && state.target) {
    return {
      kind: "update",
      calendarId: state.target.calendarId,
      eventId: state.target.eventId,
      input,
    };
  }
  return { kind: "create", input };
}

/** "Fri 1 Aug, 5:00 PM – 6:00 PM" */
function formatMeetingWindow(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime())) return "";
  const startLabel = format(start, "EEE d MMM, h:mm a");
  if (Number.isNaN(end.getTime())) return startLabel;
  return `${startLabel} – ${format(end, "h:mm a")}`;
}

/**
 * " — was Fri 1 Aug, 5:00 PM", or "" when the time is unknown. The deleted
 * event's row is usually already gone from calendar_events (sync deletes what
 * Google stops returning), so the time is best-effort by design.
 */
function formatMeetingStart(startIso: string): string {
  if (!startIso) return "";
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return "";
  return ` — was ${format(start, "EEE d MMM, h:mm a")}`;
}

// ── Component ─────────────────────────────────────────────────────────

export function MeetingInviteFields({
  value,
  onChange,
  disabled,
  existing,
  deletedLink,
  onAcknowledgeDeleted,
}: {
  value: MeetingState;
  onChange: (next: MeetingState) => void;
  disabled?: boolean;
  /** The thread's current meeting, if it has one. Drives the "moving" banner. */
  existing?: ThreadMeeting | null;
  /**
   * A meeting scheduled from this thread that has since been deleted in
   * Google and not yet dismissed. Persistent state, not a one-shot flag.
   */
  deletedLink?: ThreadMeetingRef | null;
  /** Dismiss the deleted-meeting warning. */
  onAcknowledgeDeleted?: (eventId: string) => void;
}) {
  const set = (patch: Partial<MeetingState>) => onChange({ ...value, ...patch });

  const isMoving = value.mode === "update" && !!value.target;

  // A vanished meeting is never silently recreated: with no update target, the
  // only safe default is to say so and let the user decide. Recreating on its
  // own would fire a fresh invite at every attendee of a meeting somebody
  // deliberately (or accidentally) deleted.
  if (deletedLink) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangleIcon className="size-4 mt-0.5 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium">
              The meeting previously scheduled from this thread no longer exists
            </p>
            <p className="text-muted-foreground">
              {deletedLink.title}
              {formatMeetingStart(deletedLink.start)}. It was deleted in Google
              Calendar.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onAcknowledgeDeleted?.(deletedLink.eventId)}
          >
            Dismiss
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              onAcknowledgeDeleted?.(deletedLink.eventId);
              set({ enabled: true, mode: "create", target: undefined });
            }}
          >
            Schedule a new one
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2 font-normal">
          <CalendarClockIcon className="size-4" />
          {isMoving ? "Move the calendar invite" : "Add a calendar invite"}
        </Label>
        <Switch
          checked={value.enabled}
          onCheckedChange={(v) => set({ enabled: v })}
          disabled={disabled}
        />
      </div>

      {value.enabled && isMoving && existing && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <RotateCcwIcon className="size-3.5 shrink-0" />
            Moving this thread&apos;s meeting — was{" "}
            {formatMeetingWindow(existing.start, existing.end)}
          </span>
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
            disabled={disabled}
            onClick={() => set({ mode: "create", target: undefined })}
          >
            Create a second meeting instead
          </button>
        </div>
      )}

      {value.enabled && (
        <div className="flex flex-col gap-3">
          <DateTimeFields
            date={value.date}
            onDateChange={(d) => set({ date: d })}
            startTime={value.startTime}
            onStartTimeChange={(t) => set({ startTime: t })}
            duration={value.duration}
            onDurationChange={(d) => set({ duration: d })}
            // Timed mode only — days/allDay are inert but required props.
            days="1"
            onDaysChange={() => {}}
            allDay={false}
            disabled={disabled}
          />
          <Input
            value={value.location}
            onChange={(e) => set({ location: e.target.value })}
            placeholder="Location or link (optional)"
            disabled={disabled}
          />
          <Textarea
            value={value.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Description (optional)"
            rows={2}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
