import { createHash } from "node:crypto";

import { corsair } from "@repo/corsair";
import { db, and, eq } from "@repo/database";
import { calendarEvents } from "@repo/database/models/calendar-events";
import { corsairConnectionEmails } from "@repo/database/models/corsair-connections";
import { clearThreadMeetingLookups } from "./guest-links.ts";
import type {
  CalendarEvent,
  GetEventsInput,
  CreateEventInput,
  UpdateEventInput,
  MeetStatus,
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
  /** Google's own marker for "this is the authenticated account". */
  self?: boolean;
  responseStatus?: string;
  [key: string]: unknown;
}

/**
 * The conferencing block Google attaches to an event.
 *
 * `createRequest.status.statusCode` is the only place that says whether a
 * conference we asked for actually happened: "pending", "success" or
 * "failure". `hangoutLink` being absent does not distinguish those.
 */
interface RawConferenceData {
  createRequest?: {
    requestId?: string;
    conferenceSolutionKey?: { type?: string };
    status?: { statusCode?: string };
  };
  entryPoints?: { entryPointType?: string; uri?: string }[];
  conferenceId?: string;
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
  conferenceData?: RawConferenceData;
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
 * The join URL, from either place Google puts it.
 *
 * `hangoutLink` is the convenient top-level copy, but it is not always
 * populated the instant a conference is created — the video entry point is,
 * so falling back to it means a freshly created Meet is returned on the same
 * call rather than looking absent until the next read.
 */
function extractMeetLink(raw: RawEvent): string | undefined {
  if (raw.hangoutLink) return raw.hangoutLink;
  const video = raw.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video" && !!entry.uri,
  );
  return video?.uri ?? undefined;
}

/**
 * Normalize a raw Google Calendar event into our CalendarEvent shape.
 * Handles both timed events (dateTime) and all-day events (date).
 *
 * `meetStatusOverride` exists because a plain read cannot see the difference
 * between "nobody asked for a conference" and "one was asked for and is still
 * being made" — only the call that did the asking knows. Every other caller
 * gets the honest read-side answer: a link means created, no link means none.
 */
function normalizeEvent(
  raw: RawEvent,
  meetStatusOverride?: MeetStatus,
  selfEmail?: string | null,
): CalendarEvent {
  const meetLink = extractMeetLink(raw);
  // `self` is Google's own marker and is authoritative when present; the email
  // comparison is the fallback for reads where Google didn't set it.
  const selfLower = selfEmail?.toLowerCase();
  const me = raw.attendees?.find(
    (a) => a.self === true || (!!selfLower && a.email?.toLowerCase() === selfLower),
  );
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
    // No longer dropped: the thread card names the host, which is the one
    // thing that tells a user which Google account they must be signed in as
    // to be let into their own meeting.
    organizerEmail: (raw.organizer as { email?: string } | undefined)?.email ?? undefined,
    myResponseStatus:
      me?.responseStatus === "accepted" ||
      me?.responseStatus === "declined" ||
      me?.responseStatus === "tentative" ||
      me?.responseStatus === "needsAction"
        ? me.responseStatus
        : undefined,
    meetLink,
    meetStatus: meetStatusOverride ?? (meetLink ? "created" : "none"),
    status: raw.status ?? undefined,
    htmlLink: raw.htmlLink ?? undefined,
  };
}

/**
 * A stable conference request id for an event.
 *
 * Google treats a repeat of the same `requestId` as the *same* conference, so
 * this must never be random per attempt. Otherwise:
 *
 *   create Meet → Google makes a conference → network times out → we retry
 *      stable id → the same conference comes back
 *      fresh id  → a second conference is minted
 *
 * Hashed rather than used raw because Google caps `requestId` and event ids
 * have no length guarantee worth relying on.
 */
function meetRequestId(eventId: string): string {
  return createHash("sha256").update(eventId).digest("hex").slice(0, 32);
}

/** What Google says came of a conference request, if it says anything at all. */
function readMeetStatus(raw: RawEvent): MeetStatus {
  const code = raw.conferenceData?.createRequest?.status?.statusCode;
  if (code === "success") return "created";
  if (code === "pending") return "pending";
  if (code === "failure") return "failed";
  // No createRequest block at all: either the conference predates this request
  // or Google ignored it. A link present is the only positive evidence here.
  return extractMeetLink(raw) ? "created" : "failed";
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
 * A safety net, not the primary UX: the system prompt should already have
 * resolved an unpinned past time to its next occurrence, or asked the user
 * when they explicitly pinned an already-past "today" — see the TIME RULES
 * addition in apps/web/lib/assistant/system-prompt.ts. This only catches
 * whatever still slips through; it must never be the first place a past
 * time gets rejected, since a hard refusal on every unpinned "4pm" would be
 * needless friction for the common case (there's really one sensible
 * reading — tomorrow — and no ambiguity to ask about).
 *
 * Throws rather than returning a boolean so callers get a message they can
 * hand straight to `ToolExecutionError` without composing their own.
 */
export function assertNotPast(startIso: string, timeZone?: string): void {
  const instant = new Date(normalizeToUtcTimestamp(startIso, timeZone));
  if (!Number.isNaN(instant.getTime()) && instant.getTime() < Date.now()) {
    throw new Error(
      `${startIso} (in ${timeZone ?? "UTC"}) has already passed. Ask the user which date they meant instead of guessing.`,
    );
  }
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

  // One lookup for the whole page of events, not one per event.
  const [result, selfEmail] = await Promise.all([
    tenant.googlecalendar.api.events.getMany({
      timeMin: normalizeToUtcTimestamp(input.timeMin, userTimeZone),
      timeMax: normalizeToUtcTimestamp(input.timeMax, userTimeZone),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    }),
    getCalendarAccountEmail(tenantId),
  ]);

  return (result.items ?? []).map((item: RawEvent) =>
    normalizeEvent(item, undefined, selfEmail),
  );
}

/**
 * Get a single event by ID.
 */
export async function getEvent(
  tenantId: string,
  eventId: string
): Promise<CalendarEvent> {
  const tenant = corsair.withTenant(tenantId);

  const [raw, selfEmail] = await Promise.all([
    tenant.googlecalendar.api.events.get({ id: eventId }),
    getCalendarAccountEmail(tenantId),
  ]);

  return normalizeEvent(raw as unknown as RawEvent, undefined, selfEmail);
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

  // Tell the guests, and attach the Meet conference.
  //
  // Both ride the same follow-up PUT, for the same underlying reason: the
  // plugin's eventsCreate declares `sendUpdates` and `conferenceDataVersion`
  // but builds its POST with **no query string at all**, so both are dead code
  // there. Google emails nobody, and ignores `conferenceData` outright — a
  // Meet link genuinely cannot be created on the POST. eventsUpdate *does*
  // forward its query, so the event is immediately re-sent, whole, carrying
  // whichever of the two this call needs.
  //
  // The body is the event Google just returned, echoed whole through the same
  // `stripReadOnly` the update path uses, because events.update is a PUT:
  // anything omitted would be cleared, and this write must not change the event
  // it is only trying to announce.
  const created = raw as unknown as RawEvent;
  const wantsMeet = input.addMeet === true;
  const hasGuests = !!input.attendees?.length;

  // Previously this ran only when there were guests to notify. A solo event
  // that wants a Meet link still needs the PUT, since that is the only call
  // that can carry conferenceDataVersion.
  if ((hasGuests || wantsMeet) && created.id) {
    const body = stripReadOnly(created);
    if (wantsMeet) {
      body.conferenceData = {
        createRequest: {
          requestId: meetRequestId(created.id),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    try {
      const announced = (await tenant.googlecalendar.api.events.update({
        id: created.id,
        event: body as Parameters<
          typeof tenant.googlecalendar.api.events.update
        >[0]["event"],
        sendUpdates: hasGuests ? "all" : "none",
        // ONLY here. Leaving it unset on every other update is what makes
        // Google ignore the conferenceData those calls echo back, which is
        // precisely what keeps a Meet link alive across a reschedule.
        ...(wantsMeet ? { conferenceDataVersion: 1 } : {}),
      })) as unknown as RawEvent;

      if (!wantsMeet) return normalizeEvent(announced);
      return await settleMeet(tenant, announced);
    } catch (err) {
      // The event exists; only the invitations and/or the conference failed.
      // Loud, because from the organizer's side an uninvited meeting looks
      // exactly like an invited one — and retrying the create would schedule a
      // second meeting.
      console.error(
        `[calendar-service] Event ${created.id} created but the follow-up write failed`,
        { notified: hasGuests, meetRequested: wantsMeet, error: err },
      );
      // Say what actually happened rather than reporting a linkless event as
      // if no conference had ever been asked for.
      return normalizeEvent(created, wantsMeet ? "failed" : undefined);
    }
  }

  return normalizeEvent(created, wantsMeet ? "failed" : undefined);
}

/** How long to wait before the single re-read for a still-pending conference. */
const MEET_PENDING_RECHECK_MS = 1500;

/**
 * Resolve a conference request that Google may not have finished yet.
 *
 * Meet creation is asynchronous: the PUT can return `statusCode: "pending"`
 * with no link on it. One bounded re-read covers the common case where it
 * lands moments later. If it is still pending after that we say so and stop —
 * the event is real and correctly created either way, and a later read (the
 * calendar sync, or opening the thread) will pick the link up. What we must
 * never do is return `pending` or `failure` dressed up as "no Meet link".
 */
async function settleMeet(
  tenant: ReturnType<typeof corsair.withTenant>,
  announced: RawEvent,
): Promise<CalendarEvent> {
  const status = readMeetStatus(announced);
  if (status !== "pending") return normalizeEvent(announced, status);

  await new Promise((resolve) => setTimeout(resolve, MEET_PENDING_RECHECK_MS));

  try {
    const refetched = (await tenant.googlecalendar.api.events.get({
      id: announced.id ?? "",
    })) as unknown as RawEvent;
    return normalizeEvent(refetched, readMeetStatus(refetched));
  } catch (err) {
    // The re-read is an optimization, not the source of truth. Failing it does
    // not make the conference failed — it stays pending, honestly.
    console.error(
      `[calendar-service] Meet re-read failed for event ${announced.id}; still pending`,
      err,
    );
    return normalizeEvent(announced, "pending");
  }
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

/** How an invited guest can answer. Mirrors Google's own vocabulary. */
export type AttendeeResponse = "accepted" | "declined" | "tentative";

/**
 * The connected Google Calendar account's own address.
 *
 * Deliberately the *Calendar* connection rather than the better-auth login:
 * they can legitimately differ, and the only identity Google matches an
 * attendee row against is the one that authorised the calendar.
 */
async function getCalendarAccountEmail(tenantId: string): Promise<string | null> {
  const [connection] = await db
    .select({ calendarEmail: corsairConnectionEmails.calendarEmail })
    .from(corsairConnectionEmails)
    .where(eq(corsairConnectionEmails.userId, tenantId))
    .limit(1);
  return connection?.calendarEmail ?? null;
}

/**
 * RSVP to an event this user was invited to.
 *
 * The one write in this file a non-organiser is allowed to make, and it is
 * narrow by construction rather than by permission check: it rebuilds the
 * attendee list unchanged except for the single entry whose address matches
 * the connected account, and sends nothing else. There is no argument through
 * which a caller could reach another person's response, the time, or the
 * guest list.
 *
 * Uses PATCH via raw fetch rather than the plugin's `events.update`, for two
 * reasons that both matter:
 *
 *   1. `events.update` is a PUT — the whole event — and Google refuses a
 *      non-organiser writing organiser-owned fields. An RSVP would be rejected
 *      for touching things it never meant to touch.
 *   2. The plugin exposes no `events.patch` at all, so there is no way to send
 *      only `attendees` through it.
 *
 * `sendUpdates: "none"` on purpose. Google notifies the organiser of an RSVP
 * through its own mechanism; asking it to send updates here would mail *every*
 * guest because one person clicked Maybe.
 */
export async function respondToEvent(
  tenantId: string,
  eventId: string,
  response: AttendeeResponse,
): Promise<AttendeeResponse> {
  const tenant = corsair.withTenant(tenantId);

  const selfEmail = await getCalendarAccountEmail(tenantId);
  if (!selfEmail) {
    throw new Error(
      "We don't know which Google account is connected to your calendar, so we can't RSVP for you.",
    );
  }

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

  const attendees = current.attendees ?? [];
  const selfLower = selfEmail.toLowerCase();
  const isSelf = (a: RawAttendee) =>
    a.email?.toLowerCase() === selfLower || a.self === true;

  if (!attendees.some(isSelf)) {
    // Said plainly rather than silently succeeding. "RSVP saved" on a meeting
    // that never invited you is a lie the user would only discover by asking
    // the organiser why their answer never showed up.
    throw new Error(
      "You're not on the guest list for this meeting, so there's nothing to respond to.",
    );
  }

  // Every other attendee is echoed back byte-for-byte. Rebuilding them from
  // their addresses would drop displayName, optional, organizer and — the one
  // that actually bites — everyone else's responseStatus.
  const merged = attendees.map((a) =>
    isSelf(a) ? { ...a, responseStatus: response } : a,
  );

  const accessToken = await tenant.googlecalendar.keys.get_access_token();
  if (!accessToken) {
    throw new Error("No Google Calendar access token is available for this account.");
  }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(
      eventId,
    )}?sendUpdates=none`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ attendees: merged }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[calendar-service] RSVP failed", {
      eventId,
      status: res.status,
      detail,
    });
    if (res.status === 404 || res.status === 410) {
      throw new CalendarEventGoneError(eventId);
    }
    throw new Error("Google wouldn't record that response — try again in a moment.");
  }

  return response;
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

  // Close the sync-cache row in the same breath as the event itself.
  //
  // Leaving it live is what let a cancelled meeting come back: the thread's
  // only link is now CANCELLED, so `resolveThreadMeetings` finds no ACTIVE link
  // and falls through to the guest lookup, which reads this cache, filters on
  // `status <> 'cancelled'`, matches this very row and re-links the event as
  // role GUEST — stripping the organiser of the Cancel button for a meeting
  // they had just cancelled.
  //
  // This lives here rather than in the tRPC route so the agent tool and the
  // executors get it too, not only the one path the UI happens to use.
  const [cached] = await db
    .update(calendarEvents)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(eq(calendarEvents.userId, tenantId), eq(calendarEvents.eventId, eventId)),
    )
    .returning({ threadMessageId: calendarEvents.threadMessageId });

  // The negative "no meeting on this thread" marker is now wrong in the other
  // direction. Cleared for the whole user because the cache row carries a
  // hashed Message-ID, not a Gmail thread id — over-clearing a negative cache
  // costs one lookup and nothing else. It swallows its own errors.
  if (cached?.threadMessageId) await clearThreadMeetingLookups(tenantId);
}
