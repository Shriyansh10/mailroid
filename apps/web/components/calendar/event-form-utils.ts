import DOMPurify from "dompurify";
import { addDays, differenceInCalendarDays, format } from "date-fns";

// ── Sanitizing ───────────────────────────────────────────────────────

/** Strip any markup and trim. Safe on a single field value. */
export function sanitizeText(val: string | undefined): string {
  if (!val) return "";
  return DOMPurify.sanitize(val, { ALLOWED_TAGS: [] }).trim();
}

/**
 * Pull a bare address out of a pasted recipient.
 *
 * Mail clients copy recipients as `Alice <alice@corp.com>`. DOMPurify parses the
 * angle brackets as a tag and drops the address entirely, so the address has to
 * be extracted *before* sanitizing — never after.
 */
export function extractEmail(raw: string): string {
  const angle = /<([^<>]+)>/.exec(raw);
  return sanitizeText(angle?.[1] ?? raw).toLowerCase();
}

// ── Local calendar dates ─────────────────────────────────────────────
//
// An all-day value is a *calendar date*, not an instant. It stays a
// `yyyy-MM-dd` string end to end and must never pass through `new Date(str)`,
// `toISOString()`, or any `getUTC*` — `new Date("2026-03-03")` parses as UTC
// midnight, which reads back as the previous day for anyone west of UTC.

/** Format a local Date as `yyyy-MM-dd`, using local calendar fields. */
export function toLocalDateKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/** Parse `yyyy-MM-dd` as local midnight. Ignores any time part. */
export function parseLocalDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Number of days an all-day event spans. Google's all-day `end` date is
 * exclusive, so Mar 3 → Mar 4 is a one-day event.
 */
export function allDaySpanInDays(startKey: string, endKey: string): number {
  const start = parseLocalDateKey(startKey);
  const end = parseLocalDateKey(endKey);
  if (!start || !end) return 1;
  const days = differenceInCalendarDays(end, start);
  return days >= 1 ? days : 1;
}

/** Exclusive end key for an all-day event of `days` length. */
export function allDayEndKey(start: Date, days: number): string {
  return toLocalDateKey(addDays(start, days));
}

// ── Time of day ──────────────────────────────────────────────────────

const MINUTES_IN_DAY = 24 * 60;

/**
 * Parse a typed time into minutes past local midnight.
 * Accepts `2:30 PM`, `14:30`, `1430`, `230p`, `2 pm`, `9`.
 */
export function parseTimeInput(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "");
  if (!s) return null;

  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(s);
  if (!m) return null;

  let hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];

  if (minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem.startsWith("p") ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }

  return hours * 60 + minutes;
}

/** Render minutes past midnight as `2:30 PM`. */
export function formatTimeOfDay(minutes: number): string {
  const normalized = ((minutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  const meridiem = hours < 12 ? "AM" : "PM";
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${mins.toString().padStart(2, "0")} ${meridiem}`;
}

/** Every 15-minute slot in a day, for the start-time dropdown. */
export function buildTimeOptions(): { value: number; label: string }[] {
  const options: { value: number; label: string }[] = [];
  for (let minutes = 0; minutes < MINUTES_IN_DAY; minutes += 15) {
    options.push({ value: minutes, label: formatTimeOfDay(minutes) });
  }
  return options;
}

// ── Duration ─────────────────────────────────────────────────────────

const MAX_DURATION_MINUTES = 30 * MINUTES_IN_DAY;
const DURATION_UNIT_RE = /(\d+(?:\.\d+)?)(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m)/g;

/**
 * Parse a typed duration into minutes.
 * Accepts `45`, `45m`, `1h30`, `1h 30m`, `1.5h`, `2d`.
 */
export function parseDurationInput(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;

  // A bare number means minutes.
  if (/^\d+$/.test(s)) return clampDuration(Number(s));

  let total = 0;
  let consumed = 0;
  let lastUnit: string | null = null;

  for (const match of s.matchAll(DURATION_UNIT_RE)) {
    // Anything unconsumed between matches means the input is malformed.
    if (match.index !== consumed) return null;
    const amount = Number(match[1]);
    const unit = match[2]![0]!;
    total += unit === "d" ? amount * MINUTES_IN_DAY : unit === "h" ? amount * 60 : amount;
    consumed = match.index + match[0].length;
    lastUnit = unit;
  }

  if (lastUnit === null) return null;

  // Trailing bare digits after an hour unit are minutes, as in `1h30`.
  const rest = s.slice(consumed);
  if (rest) {
    if (lastUnit !== "h" || !/^\d{1,2}$/.test(rest)) return null;
    total += Number(rest);
  }

  return clampDuration(total);
}

function clampDuration(minutes: number): number | null {
  const rounded = Math.round(minutes);
  if (!Number.isFinite(rounded) || rounded < 1 || rounded > MAX_DURATION_MINUTES) {
    return null;
  }
  return rounded;
}

/** Render minutes as `45 min`, `1 hr 30 min`, `2 days 3 hr`. */
export function formatDuration(minutes: number): string {
  const days = Math.floor(minutes / MINUTES_IN_DAY);
  const hours = Math.floor((minutes % MINUTES_IN_DAY) / 60);
  const mins = minutes % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours) parts.push(`${hours} hr`);
  if (mins || parts.length === 0) parts.push(`${mins} min`);
  return parts.join(" ");
}

/**
 * Duration presets: 15-minute steps through the first hour, 30-minute steps
 * after that, up to 8 hours.
 */
export function buildDurationOptions(): { value: number; label: string }[] {
  const values = [15, 30, 45];
  for (let minutes = 60; minutes <= 480; minutes += 30) values.push(minutes);
  return values.map((value) => ({ value, label: formatDuration(value) }));
}

// ── Timed event assembly ─────────────────────────────────────────────

/**
 * Build a local Date from a calendar date plus minutes past midnight.
 * Uses the local constructor so the wall-clock time is what the user picked.
 */
export function combineDateAndTime(date: Date, minutesOfDay: number): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Math.floor(minutesOfDay / 60),
    minutesOfDay % 60,
    0,
    0,
  );
}
