import { corsair } from "@repo/corsair";
import type {
  CalendarEvent,
  GetEventsInput,
  CreateEventInput,
  UpdateEventInput,
} from "./model.ts";

// ── Helpers ──────────────────────────────────────────────────────────

interface RawEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface RawAttendee {
  email?: string;
  displayName?: string;
  [key: string]: unknown;
}

interface RawEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: RawEventTime;
  end?: RawEventTime;
  attendees?: RawAttendee[];
  hangoutLink?: string;
  status?: string;
  htmlLink?: string;
  [key: string]: unknown;
}

/**
 * Normalize a raw Google Calendar event into our CalendarEvent shape.
 * Handles both timed events (dateTime) and all-day events (date).
 */
function normalizeEvent(raw: RawEvent): CalendarEvent {
  return {
    id: raw.id ?? "",
    title: raw.summary ?? "(No title)",
    start: raw.start?.dateTime ?? raw.start?.date ?? "",
    end: raw.end?.dateTime ?? raw.end?.date ?? "",
    allDay: !raw.start?.dateTime,
    description: raw.description ?? undefined,
    location: raw.location ?? undefined,
    attendees: raw.attendees
      ?.map((a: RawAttendee) => a.email)
      .filter((e): e is string => !!e),
    meetLink: raw.hangoutLink ?? undefined,
    status: raw.status ?? undefined,
    htmlLink: raw.htmlLink ?? undefined,
  };
}

/**
 * Build the Corsair start/end object from our simplified input.
 *
 * Google Calendar API requires either:
 *   - dateTime with an offset (e.g. "2025-02-26T10:00:00+05:30")
 *   - dateTime with a separate timeZone field
 *
 * If the input has no offset, we add timeZone: "UTC" as a safe default.
 */
export function buildEventTime(
  isoString: string,
  allDay: boolean,
  userTimeZone?: string
): { date?: string; dateTime?: string; timeZone?: string } {
  if (allDay) {
    // All-day events use YYYY-MM-DD format
    return { date: isoString.slice(0, 10) };
  }

  // Check if the string already has a timezone offset (+HH:MM, -HH:MM, or Z)
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(isoString);
  if (hasOffset) {
    return { dateTime: isoString };
  }

  // No offset — append resolved timezone
  return { dateTime: isoString, timeZone: userTimeZone || "UTC" };
}

/**
 * Google Calendar's events.list requires timeMin/timeMax as full RFC3339
 * timestamps with a timezone offset. The AI assistant sometimes generates
 * offset-less local times (e.g. "2026-07-07T00:00:00"), which Google
 * rejects with a 400 Bad Request. Treat any offset-less string as wall-clock
 * time in the given IANA timezone and convert it to a proper UTC instant.
 */
export function normalizeToUtcTimestamp(isoString: string, timeZone?: string): string {
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(isoString);
  if (hasOffset) return isoString;
  if (!timeZone) return `${isoString}Z`;

  const asIfUtc = new Date(`${isoString}Z`);
  if (Number.isNaN(asIfUtc.getTime())) return `${isoString}Z`;

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(asIfUtc).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  const asZonedWallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = asZonedWallClock - asIfUtc.getTime();

  return new Date(asIfUtc.getTime() - offsetMs).toISOString();
}

/**
 * Resolve the timezone to use for calendar events.
 * Priority: Google Calendar Canonical settings -> Fallback user browser timezone -> Fallback UTC.
 */
export async function resolveTimezone(tenantId: string, userTimeZone?: string): Promise<string> {
  const tenant = corsair.withTenant(tenantId);
  try {
    const res = await tenant.googlecalendar.api.events.getMany({ maxResults: 1 });
    if ((res as any).timeZone) {
      console.log(`[calendar-service] Inferred canonical calendar timezone for tenant ${tenantId}: "${(res as any).timeZone}"`);
      return (res as any).timeZone;
    }
  } catch (err) {
    console.warn(`[calendar-service] Failed to query primary calendar timezone, trying fallback:`, err);
  }

  if (userTimeZone) {
    console.log(`[calendar-service] Falling back to browser timezone for tenant ${tenantId}: "${userTimeZone}"`);
    return userTimeZone;
  }

  console.log(`[calendar-service] Timezone fallback to UTC for tenant ${tenantId}`);
  return "UTC";
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * List events in a date range for FullCalendar.
 * Uses singleEvents=true to expand recurring events into instances.
 */
export async function getEvents(
  tenantId: string,
  input: GetEventsInput,
  userTimeZone?: string
): Promise<CalendarEvent[]> {
  const tenant = corsair.withTenant(tenantId);

  const result = await tenant.googlecalendar.api.events.getMany({
    timeMin: normalizeToUtcTimestamp(input.timeMin, userTimeZone),
    timeMax: normalizeToUtcTimestamp(input.timeMax, userTimeZone),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });

  return (result.items ?? []).map((item: RawEvent) => normalizeEvent(item));
}

/**
 * Get a single event by ID.
 */
export async function getEvent(
  tenantId: string,
  eventId: string
): Promise<CalendarEvent> {
  const tenant = corsair.withTenant(tenantId);

  const raw = await tenant.googlecalendar.api.events.get({ id: eventId });

  return normalizeEvent(raw as unknown as RawEvent);
}

/**
 * Create a new calendar event.
 */
export async function createEvent(
  tenantId: string,
  input: CreateEventInput,
  userTimeZone?: string
): Promise<CalendarEvent> {
  const tenant = corsair.withTenant(tenantId);
  const allDay = input.allDay ?? false;
  const timeZone = await resolveTimezone(tenantId, userTimeZone);

  const event: Record<string, unknown> = {
    summary: input.title,
    start: buildEventTime(input.start, allDay, timeZone),
    end: buildEventTime(input.end, allDay, timeZone),
  };

  if (input.description) event.description = input.description;
  if (input.location) event.location = input.location;
  if (input.attendees?.length) {
    event.attendees = input.attendees.map((email) => ({ email }));
  }

  const raw = await tenant.googlecalendar.api.events.create({ event });

  return normalizeEvent(raw as unknown as RawEvent);
}

/**
 * Update an existing event. Used for:
 * - Edit modal saves
 * - Drag-and-drop (new start/end)
 * - Resize (new end)
 */
export async function updateEvent(
  tenantId: string,
  eventId: string,
  input: Omit<UpdateEventInput, "id">,
  userTimeZone?: string
): Promise<CalendarEvent> {
  const tenant = corsair.withTenant(tenantId);
  const allDay = input.allDay ?? false;
  const timeZone = await resolveTimezone(tenantId, userTimeZone);

  const eventPayload: Record<string, unknown> = {};

  if (input.title !== undefined) eventPayload.summary = input.title;
  if (input.description !== undefined) eventPayload.description = input.description;
  if (input.location !== undefined) eventPayload.location = input.location;
  if (input.start !== undefined) eventPayload.start = buildEventTime(input.start, allDay, timeZone);
  if (input.end !== undefined) eventPayload.end = buildEventTime(input.end, allDay, timeZone);
  if (input.attendees !== undefined) {
    eventPayload.attendees = input.attendees.map((email) => ({ email }));
  }

  const raw = await tenant.googlecalendar.api.events.update({
    id: eventId,
    event: eventPayload as Parameters<typeof tenant.googlecalendar.api.events.update>[0]["event"],
  });

  return normalizeEvent(raw as unknown as RawEvent);
}

/**
 * Delete an event by ID.
 */
export async function deleteEvent(
  tenantId: string,
  eventId: string
): Promise<void> {
  const tenant = corsair.withTenant(tenantId);

  await tenant.googlecalendar.api.events.delete({ id: eventId });
}
