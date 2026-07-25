"use client";

import { CalendarClockIcon } from "lucide-react";

import { Switch } from "@web/components/ui/switch";
import { Label } from "@web/components/ui/label";
import { Input } from "@web/components/ui/input";
import { Textarea } from "@web/components/ui/textarea";
import { DateTimeFields } from "@web/components/calendar/DateTimeFields";
import {
  parseTimeInput,
  parseDurationInput,
  combineDateAndTime,
  formatTimeOfDay,
  formatDuration,
} from "@web/components/calendar/event-form-utils";

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
 * Build the calendar event input from the current state, or null if the
 * meeting is disabled or the date/time/duration don't parse. Pure — the
 * caller supplies the title and attendees it owns.
 */
export function buildEventInput(
  state: MeetingState,
  title: string,
  attendees: string[],
): MeetingEventInput | null {
  if (!state.enabled || !state.date) return null;
  const minutesOfDay = parseTimeInput(state.startTime);
  const durationMinutes = parseDurationInput(state.duration);
  if (minutesOfDay === null || durationMinutes === null) return null;

  const start = combineDateAndTime(state.date, minutesOfDay);
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  return {
    title: title.trim() || "Meeting",
    start: start.toISOString(),
    end: end.toISOString(),
    ...(state.description.trim() ? { description: state.description.trim() } : {}),
    ...(state.location.trim() ? { location: state.location.trim() } : {}),
    ...(attendees.length > 0 ? { attendees } : {}),
  };
}

// ── Component ─────────────────────────────────────────────────────────

export function MeetingInviteFields({
  value,
  onChange,
  disabled,
}: {
  value: MeetingState;
  onChange: (next: MeetingState) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<MeetingState>) => onChange({ ...value, ...patch });

  return (
    <div className="rounded-lg border p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2 font-normal">
          <CalendarClockIcon className="size-4" />
          Add a calendar invite
        </Label>
        <Switch
          checked={value.enabled}
          onCheckedChange={(v) => set({ enabled: v })}
          disabled={disabled}
        />
      </div>

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
