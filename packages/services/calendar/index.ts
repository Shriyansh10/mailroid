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

// ── Writing a whole event back ───────────────────────────────────────
//
// The plugin's `events.update` is an HTTP PUT — Google's *replace the whole
// resource* verb. Every caller here sends a partial body (a drag sends
// title/start/end, the assistant's reschedule sends start/end), and Google
// reads every omission as a deletion: description, location, attendees and
// recurrence all vanish. Losing the attendees is also why a reschedule reached
// nobody — `sendUpdates: "all"` had an empty guest list to mail by the time it
// ran.
//
// So updates are read-modify-write: fetch the event, lay the caller's defined
// fields over it, send the whole thing back. That is what the verb requires,
// and it makes "only writes fields that are defined" — which every call site
// already believed — actually true.

/**
 * Fields Google owns. They come back on every read and are meaningless (or
 * harmful) in a write: a stale `sequence` can 409, and the identity fields are
 * assigned by Google, not by us. Everything else — `recurrence`, `reminders`,
 * `conferenceData`, `attachments`, `extendedProperties`, `transparency`,
 * `visibility`, `colorId`, the `guestsCan*` flags — is echoed back untouched,
 * which is the entire point.
 */
const READ_ONLY_EVENT_FIELDS: readonly string[] = [
  "kind",
  "etag",
  "created",
  "updated",
  "htmlLink",
  "iCalUID",
  "sequence",
  "creator",
  "organizer",
  "hangoutLink",
  "attendeesOmitted",
];

/** A copy of the event with Google's own fields removed, safe to send back. */
function stripReadOnly(event: RawEvent): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (READ_ONLY_EVENT_FIELDS.includes(key)) continue;
    body[key] = value;
  }
  // Cloned so nothing downstream can mutate the object we fetched — it is also
  // what we normalize and return on the failure paths.
  return structuredClone(body);
}

/**
 * Reconcile a caller's flat list of emails with the attendees Google holds.
 *
 * Existing attendees are reused **whole**, never rebuilt from their address:
 * Google's attendee carries `responseStatus`, `displayName`, `optional`,
 * `organizer`, `comment` and `additionalGuests`, and replacing it with a bare
 * `{ email }` silently discards every RSVP and re-invites people who had
 * already accepted.
 *
 * The list is authoritative — an address the caller left out is an address
 * being removed.
 */
function mergeAttendees(
  current: RawAttendee[] | undefined,
  emails: string[],
): RawAttendee[] {
  const existing = new Map<string, RawAttendee>();
  for (const attendee of current ?? []) {
    if (attendee.email) existing.set(attendee.email.toLowerCase(), attendee);
  }

  const merged: RawAttendee[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(existing.get(key) ?? { email });
  }
  return merged;
}

/**
 * The event is not there any more.
 *
 * Google says so two ways depending on how recently it happened — a 404, or a
 * 200 carrying `status: "cancelled"` — and both arrive here as this one error
 * so no caller has to know that. Never recovered from by recreating the event:
 * that fires a fresh invite at every attendee of a meeting somebody deliberately
 * deleted.
 */
export class CalendarEventGoneError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(
      "That meeting no longer exists on your calendar — it was deleted in Google Calendar.",
    );
    this.name = "CalendarEventGoneError";
    this.eventId = eventId;
  }
}

/** Corsair's ApiError carries the HTTP status. 410 is a deleted recurring instance. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { status?: unknown }).status;
  return status === 404 || status === 410;
}

/**
 * Result of a live organizer lookup. Deliberately not a bare `string | null`:
 * "the event doesn't exist" and "the event has no organizer field" are both
 * real, distinct answers the caller needs, and neither is the same thing as
 * "the lookup failed" — which is not returned here at all, it throws (see
 * below), so a genuine infra error can never be silently read as either.
 */
export type OrganizerLookup =
  | { status: "FOUND"; email: string | null }
  | { status: "NOT_FOUND" };

/**
 * The organizer of an event, straight from Google — not through
 * `normalizeEvent`/`CalendarEvent`, which drops `organizer` entirely since no
 * other caller has needed it. Exists for `getEventWriteRole`'s live fallback:
 * when neither `thread_calendar_events` nor a locally synced `calendar_events`
 * row has an opinion on who owns an event, this is the authoritative source.
 *
 * A 404/410 is real evidence (`NOT_FOUND`) and is reported, not thrown. Any
 * other error (network, auth, unexpected) is NOT caught here — it propagates,
 * so the caller can tell "we checked and there's no answer" apart from
 * "we couldn't check" and fail closed on the latter rather than guessing.
 */
export async function getEventOrganizerEmail(
  tenantId: string,
  eventId: string,
): Promise<OrganizerLookup> {
  const tenant = corsair.withTenant(tenantId);
  try {
    const raw = (await tenant.googlecalendar.api.events.get({ id: eventId })) as RawEvent;
    const organizer = raw.organizer as { email?: string } | undefined;
    return { status: "FOUND", email: organizer?.email ?? null };
  } catch (err) {
    if (isNotFound(err)) return { status: "NOT_FOUND" };
    throw err;
  }
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
 * Priority: the caller's timezone -> the calendar's own setting -> UTC.
 *
 * `userTimeZone` is expected to be ALREADY RESOLVED by
 * `resolveUserTimeZone()` in @repo/services/settings, which puts the user's
 * *stored* zone ahead of the browser header. This function stays tenant-scoped
 * and knows nothing about users or settings; it only guarantees that whatever
 * the caller resolved wins over Google's setting. Passing a raw browser header
 * here still works, but skips the stored preference — don't.
 *
 * The order used to be the other way round, which put a *setting* ahead of an
 * observation. A test account whose Google calendar was still set to UTC made
 * Mailroid write 5:00 PM as 5:00 PM UTC — 10:30 PM for a user in IST. The
 * stored instant was only ever right because the forms send an ISO string with
 * an offset already in it; an offset-less time from the model would have gone
 * out hours wrong.
 *
 * `userTimeZone` comes from the browser, which knows where the user is right
 * now. The calendar setting only says what they once told Google. When there
 * is no caller zone at all — a server-side turn — the setting is still the
 * best thing available, so it stays as the fallback.
 */
export async function resolveTimezone(tenantId: string, userTimeZone?: string): Promise<string> {
  if (userTimeZone) {
    return userTimeZone;
  }

  const tenant = corsair.withTenant(tenantId);
  try {
    const res = await tenant.googlecalendar.api.events.getMany({ maxResults: 1 });
    if ((res as any).timeZone) {
      console.log(`[calendar-service] No caller timezone; using the calendar's own setting for tenant ${tenantId}: "${(res as any).timeZone}"`);
      return (res as any).timeZone;
    }
  } catch (err) {
    console.warn(`[calendar-service] Failed to query primary calendar timezone, trying fallback:`, err);
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

  // Set in the CREATE body rather than patched on afterwards, so a failed
  // announce-update below cannot leave the event without its marker.
  //
  // The Corsair plugin's zod type omits `extendedProperties`, but it never
  // validates and forwards the body verbatim, so this reaches Google — and
  // `stripReadOnly` deliberately doesn't list the field, so the announce PUT
  // round-trips it. Both verified against real Google by
  // `pnpm admin calendar:probe-shared-props`.
  if (input.sharedProperties && Object.keys(input.sharedProperties).length > 0) {
    const shared: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.sharedProperties)) {
      // Skip rather than truncate: an over-long value would never match on a
      // filtered lookup while looking perfectly healthy in the event.
      if (key.length > 44 || value.length > 1024) {
        console.error(
          `[calendar-service] shared property "${key}" exceeds Google's limits; omitted`,
        );
        continue;
      }
      shared[key] = value;
    }
    if (Object.keys(shared).length > 0) event.extendedProperties = { shared };
  }

  const raw = await tenant.googlecalendar.api.events.create({
    event: event as Parameters<typeof tenant.googlecalendar.api.events.create>[0]["event"],
  });

  // Tell the guests.
  //
  // The plugin's eventsCreate declares `sendUpdates` but builds its POST with
  // no query string, so the parameter is dead code there and Google emails
  // nobody — a meeting Dobbie scheduled existed only on the organizer's
  // calendar. eventsUpdate *does* pass it, so the event is immediately
  // re-sent, whole, with `sendUpdates: "all"`.
  //
  // The body is the event Google just returned, echoed whole through the same
  // `stripReadOnly` the update path uses, because events.update is a PUT:
  // anything omitted would be cleared, and this write must not change the event
  // it is only trying to announce.
  const created = raw as unknown as RawEvent;
  if (input.attendees?.length && created.id) {
    try {
      const announced = await tenant.googlecalendar.api.events.update({
        id: created.id,
        event: stripReadOnly(created) as Parameters<
          typeof tenant.googlecalendar.api.events.update
        >[0]["event"],
        sendUpdates: "all",
      });
      return normalizeEvent(announced as unknown as RawEvent);
    } catch (err) {
      // The event exists; only the invitations failed. Loud, because from the
      // organizer's side an uninvited meeting looks exactly like an invited
      // one — and retrying the create would schedule a second meeting.
      console.error(
        `[calendar-service] Event ${created.id} created but attendees were not notified:`,
        err,
      );
    }
  }

  return normalizeEvent(created);
}

/**
 * Add shared extended properties to an event WITHOUT notifying anyone.
 *
 * Exists for the backfill that stamps historical meetings with their thread's
 * Message-ID. Deliberately not part of `updateEvent`: that one is for changes
 * attendees should hear about, and this is explicitly for a change they must
 * not, since nothing about the meeting itself is moving.
 *
 * Two things carry the "silent" guarantee, and both matter:
 *
 *  - `sendUpdates: "none"`. The Corsair plugin exposes no `events.patch`, so
 *    this has to go through `events.update`, whose create-path sibling passes
 *    `sendUpdates: "all"` on purpose to invite guests. Getting this wrong
 *    would email every attendee of every historical meeting.
 *  - `stripReadOnly` + a whole-event body. `events.update` is a PUT, so any
 *    field omitted is CLEARED. The existing event is read back and echoed
 *    whole, with only extendedProperties merged in.
 */
export async function addEventSharedProperties(
  tenantId: string,
  eventId: string,
  shared: Record<string, string>,
): Promise<void> {
  const tenant = corsair.withTenant(tenantId);

  const current = (await tenant.googlecalendar.api.events.get({
    id: eventId,
  })) as unknown as RawEvent & {
    extendedProperties?: { shared?: Record<string, string>; private?: Record<string, string> };
  };

  const body = stripReadOnly(current);
  body.extendedProperties = {
    ...(current.extendedProperties ?? {}),
    // Merge, never replace: another key on this event is not ours to drop.
    shared: { ...(current.extendedProperties?.shared ?? {}), ...shared },
  };

  await tenant.googlecalendar.api.events.update({
    id: eventId,
    event: body as Parameters<typeof tenant.googlecalendar.api.events.update>[0]["event"],
    sendUpdates: "none",
  });
}

/**
 * Update an existing event. Used for:
 * - Edit modal saves
 * - Drag-and-drop (new start/end)
 * - Resize (new end)
 * - Rescheduling a thread's meeting, from the UI and from the assistant
 *
 * Read-modify-write: callers pass only what they are changing, and everything
 * they don't mention survives. See the note above `READ_ONLY_EVENT_FIELDS` for
 * why that takes a round trip rather than a partial body.
 *
 * `undefined` vs. `[]` on `input.attendees` are NOT the same thing, and
 * confusing them is exactly what broke thread rescheduling: `undefined` means
 * "don't touch the guest list" and it stays whatever it already was on
 * Google. `[]` is a real, explicit list of zero people — `mergeAttendees`
 * below will treat everyone currently invited as removed and Google will
 * cancel the meeting for all of them. Every other optional field on `input`
 * (`title`, `description`, `location`, `start`, `end`) follows the same
 * "undefined preserves, a value overwrites" rule; only `attendees` has this
 * extra footgun because an empty array is meaningful input rather than an
 * obviously-accidental value.
 *
 * Throws {@link CalendarEventGoneError} when the event has been deleted.
 */
export async function updateEvent(
  tenantId: string,
  eventId: string,
  input: Omit<UpdateEventInput, "id">,
  userTimeZone?: string
): Promise<CalendarEvent> {
  const tenant = corsair.withTenant(tenantId);
  const timeZone = await resolveTimezone(tenantId, userTimeZone);

  let current: RawEvent;
  try {
    current = (await tenant.googlecalendar.api.events.get({
      id: eventId,
    })) as unknown as RawEvent;
  } catch (err) {
    if (isNotFound(err)) throw new CalendarEventGoneError(eventId);
    throw err;
  }
  if (!current?.id || current.status === "cancelled") {
    throw new CalendarEventGoneError(eventId);
  }

  // Read from the event, not defaulted to `false`: an all-day event dragged in
  // month view sends no `allDay`, and defaulting would rewrite it as a timed
  // event starting at midnight.
  const allDay = input.allDay ?? !current.start?.dateTime;

  const eventPayload = stripReadOnly(current);

  if (input.title !== undefined) eventPayload.summary = input.title;
  if (input.description !== undefined) eventPayload.description = input.description;
  if (input.location !== undefined) eventPayload.location = input.location;
  if (input.start !== undefined) eventPayload.start = buildEventTime(input.start, allDay, timeZone);
  if (input.end !== undefined) eventPayload.end = buildEventTime(input.end, allDay, timeZone);
  if (input.attendees !== undefined) {
    eventPayload.attendees = mergeAttendees(current.attendees, input.attendees);
  }

  const raw = await tenant.googlecalendar.api.events.update({
    id: eventId,
    event: eventPayload as Parameters<typeof tenant.googlecalendar.api.events.update>[0]["event"],
    // Tell the attendees. Rescheduling from a mail thread is otherwise
    // invisible to everyone but the organizer — the event quietly moves and
    // the guests keep the old time. createEvent goes through this same call
    // for exactly that reason; see the note there.
    sendUpdates: "all",
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

  // Send the cancellation to attendees — see the note in updateEvent.
  await tenant.googlecalendar.api.events.delete({
    id: eventId,
    sendUpdates: "all",
  });
}
