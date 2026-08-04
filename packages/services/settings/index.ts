import { z } from "zod";
import { db, eq, isNull } from "@repo/database";
// @ts-ignore — re-exported via schema.ts
import { userSettings } from "@repo/database/schema";

/**
 * User settings: the preferences that drive scheduling, kept separate from
 * identity. Zod is the integrity gate on every write into the `data` blob —
 * nothing reaches the column without passing through `UserSettingsDataSchema`.
 */

// ── Working hours ────────────────────────────────────────────────────

/** `HH:mm`, 24-hour. Stored as a string so it is a wall-clock time, not an instant. */
const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm (24-hour)");

/**
 * Days are ISO-ish weekday numbers matching `Date.getDay()`: 0 = Sunday,
 * 6 = Saturday. Same convention as everything else in the codebase that
 * touches weekdays, so no translation layer is needed at the boundary.
 */
const WeekdaySchema = z.number().int().min(0).max(6);

export const WorkingHoursSchema = z
  .object({
    start: TimeOfDaySchema,
    end: TimeOfDaySchema,
    days: z.array(WeekdaySchema).min(1).max(7),
  })
  .refine((wh) => wh.start < wh.end, {
    message: "Working hours must start before they end",
    path: ["end"],
  });

export type WorkingHours = z.infer<typeof WorkingHoursSchema>;

// ── The settings blob ────────────────────────────────────────────────

export const USER_SETTINGS_VERSION = 1;

export const UserSettingsDataSchema = z.object({
  version: z.number().int().positive(),
  workingHours: WorkingHoursSchema,
  /** Default meeting length when neither the request nor a rule says otherwise. */
  defaultDurationMinutes: z.number().int().min(5).max(480),
  /** How far ahead a meeting must be before it can be proposed at all. */
  minimumNoticeMinutes: z.number().int().min(0).max(60 * 24 * 7),
});

export type UserSettingsData = z.infer<typeof UserSettingsDataSchema>;

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  start: "09:00",
  end: "18:00",
  days: [1, 2, 3, 4, 5],
};

export const DEFAULT_SETTINGS_DATA: UserSettingsData = {
  version: USER_SETTINGS_VERSION,
  workingHours: DEFAULT_WORKING_HOURS,
  defaultDurationMinutes: 30,
  minimumNoticeMinutes: 30,
};

export interface UserSettings {
  userId: string;
  /** NULL until a turn first observes one — "never seen", not "UTC". */
  timeZone: string | null;
  data: UserSettingsData;
}

// ── Reads ────────────────────────────────────────────────────────────

/**
 * Read a user's settings, falling back to defaults for anyone who has never
 * saved any. Never returns undefined: every caller wants a usable settings
 * object, and "no row yet" is not a different behaviour from "defaults".
 *
 * A row whose blob fails validation (hand-edited, or written by an older
 * shape that has since changed incompatibly) falls back to defaults and logs
 * loudly rather than throwing — a malformed preference must not take the
 * whole assistant turn down with it.
 */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { userId, timeZone: null, data: DEFAULT_SETTINGS_DATA };
  }

  const parsed = UserSettingsDataSchema.safeParse(row.data);
  if (!parsed.success) {
    console.warn("[settings:invalid-blob]", {
      userId,
      issues: parsed.error.issues.map((i) => i.path.join(".")),
    });
    return { userId, timeZone: row.timeZone ?? null, data: DEFAULT_SETTINGS_DATA };
  }

  return { userId, timeZone: row.timeZone ?? null, data: parsed.data };
}

// ── Writes ───────────────────────────────────────────────────────────

/**
 * Upsert the settings blob. Partial: only the keys supplied are changed, so a
 * Settings form that owns working hours cannot blank out the duration
 * defaults it never rendered.
 */
export async function updateUserSettings(
  userId: string,
  patch: Partial<Omit<UserSettingsData, "version">>,
): Promise<UserSettings> {
  const current = await getUserSettings(userId);
  const next = UserSettingsDataSchema.parse({
    ...current.data,
    ...patch,
    version: USER_SETTINGS_VERSION,
  });

  await db
    .insert(userSettings)
    .values({ userId, timeZone: current.timeZone, data: next })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { data: next, updatedAt: new Date() },
    });

  return { userId, timeZone: current.timeZone, data: next };
}

/** Explicitly set the stored timezone (Settings UI). */
export async function setUserTimeZone(
  userId: string,
  timeZone: string,
): Promise<void> {
  const current = await getUserSettings(userId);
  await db
    .insert(userSettings)
    .values({ userId, timeZone, data: current.data })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { timeZone, updatedAt: new Date() },
    });
}

/**
 * Record the browser-reported zone the first time we see one, without ever
 * overwriting a zone already stored.
 *
 * This is the backfill that makes the stored zone authoritative for existing
 * users. It deliberately loses the race by design: `WHERE time_zone IS NULL`
 * lives in the statement, so two concurrent turns cannot fight, and an
 * explicit choice made in Settings is never clobbered by whatever browser the
 * user happens to open next.
 */
export async function rememberTimeZoneIfUnset(
  userId: string,
  timeZone: string,
): Promise<void> {
  if (!isValidTimeZone(timeZone)) return;

  const current = await getUserSettings(userId);
  if (current.timeZone) return;

  await db
    .insert(userSettings)
    .values({ userId, timeZone, data: current.data })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { timeZone, updatedAt: new Date() },
      // The guard is in the statement, not in the read above: two concurrent
      // turns racing to backfill cannot overwrite each other, and a zone set
      // deliberately in Settings is never clobbered by a later browser header.
      where: isNull(userSettings.timeZone),
    });
}

/**
 * The single place the scheduling timezone precedence is decided:
 *
 *   stored zone  →  browser header  →  (calendar's own setting, downstream)
 *
 * A stored zone is an explicit statement about where this user schedules. The
 * browser header is an observation of where the machine is right now — good,
 * but wrong on a borrowed laptop or a VPN. Google's calendar setting is last
 * because it is only what the user once told Google, and a test account left
 * on UTC is exactly how the M1 timezone defect produced times hours out.
 *
 * Returning `undefined` when neither source has anything is deliberate: it
 * lets `resolveTimezone` fall through to the calendar setting rather than
 * asserting a UTC that nobody chose.
 *
 * Also opportunistically backfills the stored zone from the header, so the
 * first turn a user takes makes their zone durable.
 */
export async function resolveUserTimeZone(
  userId: string,
  headerTimeZone?: string,
): Promise<string | undefined> {
  const settings = await getUserSettings(userId);
  if (settings.timeZone) return settings.timeZone;

  if (headerTimeZone && isValidTimeZone(headerTimeZone)) {
    await rememberTimeZoneIfUnset(userId, headerTimeZone);
    return headerTimeZone;
  }

  return undefined;
}

/** Cheap validity check — `Intl` is the only real authority on IANA names. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
