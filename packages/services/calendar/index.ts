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
function buildEventTime(
  isoString: string,
  allDay: boolean
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

  // No offset — append timeZone so Google Calendar accepts it
  return { dateTime: isoString, timeZone: "UTC" };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * List events in a date range for FullCalendar.
 * Uses singleEvents=true to expand recurring events into instances.
 */
export async function getEvents(
  tenantId: string,
  input: GetEventsInput
): Promise<CalendarEvent[]> {
  const tenant = corsair.withTenant(tenantId);

  const result = await tenant.googlecalendar.api.events.getMany({
    timeMin: input.timeMin,
    timeMax: input.timeMax,
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
  input: CreateEventInput
): Promise<CalendarEvent> {
  const tenant = corsair.withTenant(tenantId);
  const allDay = input.allDay ?? false;

  const event: Record<string, unknown> = {
    summary: input.title,
    start: buildEventTime(input.start, allDay),
    end: buildEventTime(input.end, allDay),
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
  input: Omit<UpdateEventInput, "id">
): Promise<CalendarEvent> {
  const tenant = corsair.withTenant(tenantId);
  const allDay = input.allDay ?? false;

  const eventPayload: Record<string, unknown> = {};

  if (input.title !== undefined) eventPayload.summary = input.title;
  if (input.description !== undefined) eventPayload.description = input.description;
  if (input.location !== undefined) eventPayload.location = input.location;
  if (input.start !== undefined) eventPayload.start = buildEventTime(input.start, allDay);
  if (input.end !== undefined) eventPayload.end = buildEventTime(input.end, allDay);
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
