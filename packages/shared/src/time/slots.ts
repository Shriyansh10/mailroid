/**
 * Free/busy and slot finding — the deterministic core of the scheduling
 * engine.
 *
 * Everything here is pure: no I/O, no model, no ambient clock unless one is
 * passed in. That is the point. `CLAUDE.md` asks for a testable function
 * rather than behaviour nobody can reproduce, and availability is precisely
 * the part that must never be a guess.
 *
 * Unlike the display helpers in `./index.ts`, these are ZONE-AWARE. Working
 * hours are a wall-clock statement ("I work 9 to 6") that only means anything
 * in a named zone, and the server's ambient zone is not the user's.
 */

/** A half-open interval `[start, end)`. */
export interface Interval {
  start: Date;
  end: Date;
}

/** Working hours as stored in user settings. `days` uses `Date.getDay()` numbering. */
export interface WorkingHoursSpec {
  start: string;
  end: string;
  days: number[];
}

const MS_IN_MINUTE = 60_000;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * An instant's wall-clock fields as seen in a given zone.
 *
 * Every zone-aware helper below is some view of this: `Intl` already ships the
 * tz database, so formatting an instant *into* a zone and reading the fields
 * back is all the conversion any of them needs.
 */
function zonedParts(
  instant: Date,
  timeZone: string,
): Record<string, string> {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(instant)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
}

/**
 * The zone's UTC offset, in ms, at a given instant.
 *
 * Same technique as `normalizeToUtcTimestamp` in `@repo/services/calendar`:
 * format the instant *as if* it were in the target zone, read the wall-clock
 * fields back, and diff. Handles DST without shipping a tz database, because
 * `Intl` already has one.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);

  const asWallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asWallClock - instant.getTime();
}

/** Matches an ISO-8601 string that already pins an absolute instant. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;
/** `YYYY-MM-DDTHH:MM` with optional `:SS` and optional fractional seconds. */
const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/**
 * An instant rendered as offset-less local wall-clock: `2026-08-05T09:00:00`.
 *
 * The inverse of `parseZonedWallClock`, and the format every model-facing time
 * in this codebase uses. Slot times used to cross that boundary as
 * `.toISOString()` — a correct instant whose digits read as a completely
 * different local time, which is how a 09:00 IST slot got offered, and booked,
 * as 03:30. Nothing downstream can tell UTC digits from local digits, so the
 * only fix that holds is emitting the convention everything else already
 * speaks.
 */
export function formatZonedWallClock(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) return "";
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Read a time string back into a real instant.
 *
 * Accepts both forms on purpose:
 *   - carries `Z` or `±HH:MM` → already absolute, parsed as-is
 *   - offset-less → wall-clock *in `timeZone`*, never in the server's zone
 *
 * The first branch is what lets stored records written before slot times
 * became local keep resolving correctly, so no backfill is needed. The second
 * is the actual bug fix: bare `new Date("2026-08-05T09:00:00")` resolves
 * against the *server's* zone, which on a UTC host silently shifts every
 * user-supplied time by their whole offset.
 */
export function parseZonedWallClock(
  value: string,
  timeZone: string,
): Date | null {
  const raw = value?.trim();
  if (!raw) return null;

  if (HAS_OFFSET.test(raw)) {
    const absolute = new Date(raw);
    return Number.isNaN(absolute.getTime()) ? null : absolute;
  }

  const m = WALL_CLOCK.exec(raw);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? 0);

  // Range-checked rather than left to Date.UTC, which silently ROLLS OVER:
  // "2026-13-45T99:99:99" is well-formed to the regex and becomes a real
  // instant in 2027. A nonsense time must be rejected so the caller can say so
  // — quietly resolving it to a plausible-looking date is the failure mode
  // this whole area keeps producing.
  //
  // Hour 24 is allowed: working hours may end at "24:00", meaning midnight at
  // the end of the day, and that must roll to the next date by design.
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 24 || (hour === 24 && (minute > 0 || second > 0))) return null;
  if (minute > 59 || second > 59) return null;

  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(naiveUtc)) return null;

  // Catches a day that doesn't exist in that month (31 April, 30 February),
  // which passes the range check above but still rolls forward.
  const rolled = new Date(naiveUtc);
  const dayShift = hour === 24 ? 1 : 0;
  if (
    rolled.getUTCFullYear() !== year ||
    rolled.getUTCMonth() !== month - 1 ||
    rolled.getUTCDate() !== day + dayShift
  ) {
    // A day-24 roll legitimately crosses into the next month or year, so only
    // reject when the date moved for a reason other than that.
    if (dayShift === 0) return null;
    const expected = new Date(Date.UTC(year, month - 1, day));
    expected.setUTCDate(expected.getUTCDate() + 1);
    if (rolled.getTime() !== expected.getTime()) return null;
  }

  // Two passes, for the same reason `zonedWallClockToUtc` uses two: across a
  // DST boundary the offset at the naive guess differs from the one that
  // actually applies at the target instant.
  let instant = new Date(naiveUtc - zoneOffsetMs(new Date(naiveUtc), timeZone));
  instant = new Date(naiveUtc - zoneOffsetMs(instant, timeZone));
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Convert a wall-clock date + time in `timeZone` into a real UTC instant.
 *
 * The offset is resolved twice — once from a naive guess, then again at the
 * candidate instant. A single pass is wrong across a DST boundary, where the
 * offset that applies *at the target time* differs from the one at the guess.
 */
export function zonedWallClockToUtc(
  dateKey: string,
  timeOfDay: string,
  timeZone: string,
): Date | null {
  // Validation stays stricter than `parseZonedWallClock`'s — this takes the two
  // halves separately and callers pass a working-hours `"HH:mm"`, so a value
  // carrying seconds is a bug at the call site rather than input to tolerate.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  if (!/^\d{2}:\d{2}$/.test(timeOfDay)) return null;
  return parseZonedWallClock(`${dateKey}T${timeOfDay}:00`, timeZone);
}

/** `Date.getDay()`-style weekday (0 = Sunday) for an instant, in a given zone. */
export function weekdayInZone(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(instant);
  const idx = WEEKDAY_NAMES.indexOf(name);
  return idx === -1 ? instant.getDay() : idx;
}

/** `yyyy-MM-dd` for an instant, as seen in a given zone. */
export function dateKeyInZone(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Minutes since midnight for an instant, in a given zone. */
export function minutesOfDayInZone(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** `"HH:mm"` → minutes since midnight. Returns null on a malformed value. */
export function parseClock(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : null;
}

/**
 * Expand a date range into one bookable window per working day, clipped to
 * working hours in the user's zone.
 *
 * A day not in `workingHours.days` produces no window at all — it is absent
 * rather than empty, so nothing downstream can schedule into it by treating a
 * zero-length window as "anything goes".
 */
export function buildDailyWindows(
  range: Interval,
  workingHours: WorkingHoursSpec,
  timeZone: string,
): Interval[] {
  const windows: Interval[] = [];
  const allowedDays = new Set(workingHours.days);
  const seen = new Set<string>();

  // Walk in 6-hour steps and de-duplicate by zone-local date key, rather than
  // adding 86_400_000ms per day: a DST transition makes a "day" 23 or 25 hours
  // long, and stepping by a fixed day would drift past or repeat a date.
  let cursor = range.start.getTime();
  const limit = range.end.getTime();

  while (cursor <= limit) {
    const key = dateKeyInZone(new Date(cursor), timeZone);
    if (!seen.has(key)) {
      seen.add(key);

      const dayStart = zonedWallClockToUtc(key, workingHours.start, timeZone);
      const dayEnd = zonedWallClockToUtc(key, workingHours.end, timeZone);

      if (dayStart && dayEnd && allowedDays.has(weekdayInZone(dayStart, timeZone))) {
        const start = Math.max(dayStart.getTime(), range.start.getTime());
        const end = Math.min(dayEnd.getTime(), range.end.getTime());
        if (start < end) windows.push({ start: new Date(start), end: new Date(end) });
      }
    }
    cursor += 6 * 60 * MS_IN_MINUTE;
  }

  return windows;
}

/** Sort and merge overlapping or touching intervals into a minimal set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals
    .filter((i) => i.start.getTime() < i.end.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: Interval[] = [];
  for (const current of valid) {
    const last = merged[merged.length - 1];
    if (last && current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) {
        last.end = new Date(current.end.getTime());
      }
    } else {
      merged.push({
        start: new Date(current.start.getTime()),
        end: new Date(current.end.getTime()),
      });
    }
  }
  return merged;
}

/** Subtract busy intervals from a window, returning the free gaps. */
export function subtractIntervals(window: Interval, busy: Interval[]): Interval[] {
  const gaps: Interval[] = [];
  let cursor = window.start.getTime();
  const windowEnd = window.end.getTime();

  for (const b of busy) {
    if (b.end.getTime() <= cursor) continue;
    if (b.start.getTime() >= windowEnd) break;

    if (b.start.getTime() > cursor) {
      gaps.push({
        start: new Date(cursor),
        end: new Date(Math.min(b.start.getTime(), windowEnd)),
      });
    }
    cursor = Math.max(cursor, b.end.getTime());
    if (cursor >= windowEnd) break;
  }

  if (cursor < windowEnd) {
    gaps.push({ start: new Date(cursor), end: new Date(windowEnd) });
  }
  return gaps;
}

export interface FindFreeSlotsOptions {
  durationMinutes: number;
  /** Dead time kept either side of an existing meeting. */
  bufferMinutes?: number;
  /** How soon from `now` a slot may start. */
  minimumNoticeMinutes?: number;
  /** Candidate start times are aligned to this grid. Default 15. */
  stepMinutes?: number;
  /** Omit to disable the minimum-notice floor entirely (pure tests). */
  now?: Date;
  /** Safety valve so a wide range cannot produce an unbounded list. */
  maxResults?: number;
}

/**
 * Every bookable slot of exactly `durationMinutes` inside `windows` that does
 * not collide with `busy`.
 *
 * Returns discrete slots rather than free *gaps* on purpose: the scorer ranks
 * candidate meeting times, and a two-hour gap is not one candidate but many.
 * Starts align to a `stepMinutes` grid so suggestions land on times a human
 * would actually propose — 2:00 or 2:15, never 2:07.
 *
 * Buffer widens each busy interval before subtraction, which is what "keep 15
 * minutes between meetings" actually means: the free gap either side of a
 * commitment shrinks, and no slot may begin inside that padding.
 */
export function findFreeSlots(
  busy: Interval[],
  windows: Interval[],
  opts: FindFreeSlotsOptions,
): Interval[] {
  const {
    durationMinutes,
    bufferMinutes = 0,
    minimumNoticeMinutes = 0,
    stepMinutes = 15,
    now,
    maxResults = 200,
  } = opts;

  if (durationMinutes <= 0) return [];

  const durationMs = durationMinutes * MS_IN_MINUTE;
  const stepMs = Math.max(1, stepMinutes) * MS_IN_MINUTE;
  const bufferMs = Math.max(0, bufferMinutes) * MS_IN_MINUTE;

  const earliestStart = now
    ? now.getTime() + minimumNoticeMinutes * MS_IN_MINUTE
    : Number.NEGATIVE_INFINITY;

  const paddedBusy = mergeIntervals(
    busy.map((b) => ({
      start: new Date(b.start.getTime() - bufferMs),
      end: new Date(b.end.getTime() + bufferMs),
    })),
  );

  const slots: Interval[] = [];

  for (const window of windows) {
    for (const gap of subtractIntervals(window, paddedBusy)) {
      const gapStart = Math.max(gap.start.getTime(), earliestStart);
      // Align up to the grid so starts are proposable times.
      let candidate = Math.ceil(gapStart / stepMs) * stepMs;

      while (candidate + durationMs <= gap.end.getTime()) {
        slots.push({
          start: new Date(candidate),
          end: new Date(candidate + durationMs),
        });
        if (slots.length >= maxResults) return slots;
        candidate += stepMs;
      }
    }
  }

  return slots;
}
