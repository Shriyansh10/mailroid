import { db, and, eq, desc, isNull } from "@repo/database";
import { calendarEvents } from "@repo/database/models/calendar-events";
import { threadCalendarEvents } from "@repo/database/models/thread-calendar-events";

import { getEvent, getEventOrganizerEmail } from "./index.ts";
import { findGuestThreadMeetings, type GuestResolution } from "./guest-links.ts";
import { getAccountEmail } from "../gmail/index.ts";
import { isUpcomingMeeting, partitionMeetingsByTime } from "@repo/shared/calendar";

/**
 * Thread ↔ calendar-event links.
 *
 * The one place that owns the relationship between a Gmail thread and the
 * events scheduled from it. Everything else — the compose surfaces, the tRPC
 * routes, the assistant's tools — goes through here rather than reasoning
 * about the table directly.
 *
 * Two rules are load-bearing:
 *
 *  1. The link table stores only the relationship. Titles, times and attendees
 *     are always resolved from Google, so an event edited on /calendar or in
 *     Google Calendar directly is never stale here.
 *  2. Deletion is only ever concluded from the Calendar API, never from a
 *     missing `calendar_events` row — see `resolveLinks` below.
 */

const DEFAULT_CALENDAR_ID = "primary";

/**
 * The token the model uses to name one of a thread's meetings.
 *
 * Derived from the event id rather than stored, which is what makes it stable:
 * the same meeting always yields the same token, so a token stays valid no
 * matter how many meetings are scheduled or cancelled around it. That is the
 * whole point — a position ("meeting 2") silently means a *different* meeting
 * once the list changes, and the list is ordered newest-first.
 *
 * Opaque, not secret. Nothing is protected by its unguessability: resolution
 * only ever searches the meetings already active on this user's thread
 * (`resolveSelection` below), so a forged token can at most match something
 * the user already owns there. It exists so no real Google event id crosses
 * the model boundary — an event id pasted into an email body must stay
 * inexpressible, per the note on the thread tools in the registry.
 */
export function selectionIdFor(eventId: string): string {
  // FNV-1a, 32-bit. Not cryptographic and doesn't need to be; it needs to be
  // stable, short enough to copy without error, and dependency-free.
  let hash = 0x811c9dc5;
  for (let i = 0; i < eventId.length; i++) {
    hash ^= eventId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `m-${hash.toString(36).padStart(7, "0")}`;
}

export interface ThreadMeeting {
  eventId: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  htmlLink?: string;
  /** The Google Meet join URL, when the meeting has a conference attached. */
  meetLink?: string;
  /**
   * Where and what. Carried so the thread card can show the organiser the same
   * details Google mails to the *guests* — the organiser gets no such mail, so
   * without these the person who scheduled the meeting is the one person who
   * cannot see what they scheduled.
   */
  location?: string;
  description?: string;
  /**
   * The organizer, i.e. the Meet host. Singular by Google's own data model —
   * `organizer` on a Calendar event is one object, not a list. Co-hosts are a
   * Meet-side concept with no representation in the Calendar API at all.
   */
  organizerEmail?: string;
  /**
   * This user's own RSVP. `needsAction` means invited but unanswered;
   * `undefined` means the question does not apply to them.
   */
  myResponseStatus?: "needsAction" | "accepted" | "declined" | "tentative";
  /**
   * Whether this user owns the meeting or was only invited. Write paths must
   * check it: only the organiser can move or cancel.
   */
  role: "ORGANIZER" | "GUEST";
}

/** Just enough to name a meeting that no longer exists. */
export interface ThreadMeetingRef {
  eventId: string;
  calendarId: string;
  title: string;
  start: string;
}

// ── Writing links ─────────────────────────────────────────────────────

export interface LinkThreadEventInput {
  userId: string;
  threadId: string;
  eventId: string;
  calendarId?: string;
  entityId?: string;
  /**
   * ORGANIZER (the default) means this user created the meeting and may move
   * or cancel it. GUEST means they were invited and the link exists only so
   * they can SEE it — see resolveTargetOrThrow, which refuses writes on a
   * guest row.
   */
  role?: "ORGANIZER" | "GUEST";
}

/**
 * Record that `eventId` was scheduled from `threadId`.
 *
 * Callers must await this and treat a failure as an error — never
 * fire-and-forget. An event created in Google but not linked here is invisible
 * to the thread, so scheduling again would silently duplicate it; the caller
 * has to be able to say so.
 */
export async function linkThreadEvent(
  input: LinkThreadEventInput,
): Promise<void> {
  await db
    .insert(threadCalendarEvents)
    .values({
      userId: input.userId,
      threadId: input.threadId,
      eventId: input.eventId,
      calendarId: input.calendarId ?? DEFAULT_CALENDAR_ID,
      entityId: input.entityId ?? null,
      role: input.role ?? "ORGANIZER",
    })
    .onConflictDoNothing({
      target: [
        threadCalendarEvents.userId,
        threadCalendarEvents.calendarId,
        threadCalendarEvents.eventId,
      ],
    });
}

/**
 * Move a link out of ACTIVE. Only ever closes: never resurrects a row, never
 * rewrites its eventId (rows are immutable history).
 */
export async function closeThreadLink(
  userId: string,
  calendarId: string,
  eventId: string,
  status: "CANCELLED" | "DELETED_EXTERNALLY",
): Promise<void> {
  await db
    .update(threadCalendarEvents)
    .set({ status, closedAt: new Date() })
    .where(
      and(
        eq(threadCalendarEvents.userId, userId),
        eq(threadCalendarEvents.calendarId, calendarId),
        eq(threadCalendarEvents.eventId, eventId),
        eq(threadCalendarEvents.status, "ACTIVE"),
      ),
    );
}

/** Mark the "this meeting no longer exists" banner as seen. */
export async function acknowledgeThreadLink(
  userId: string,
  eventId: string,
): Promise<void> {
  await db
    .update(threadCalendarEvents)
    .set({ acknowledgedAt: new Date() })
    .where(
      and(
        eq(threadCalendarEvents.userId, userId),
        eq(threadCalendarEvents.eventId, eventId),
      ),
    );
}

// ── Reading links ─────────────────────────────────────────────────────

/**
 * Resolve active links against Google, self-healing any that have vanished.
 *
 * `calendar_events` is a sync cache, not a source of truth: it is populated by
 * the calendar webhook, it only covers a −7d/+30d window, and `syncCalendarEvents`
 * *deletes* rows it no longer sees rather than marking them cancelled. So a
 * missing row means "not synced yet" at least as often as it means "gone", and
 * concluding deletion from its absence would fire the warning banner at
 * meetings that are perfectly alive — including one created seconds ago.
 *
 * So: no local row → ask Google. Stamp DELETED_EXTERNALLY only on a genuine
 * 404 (Corsair's ApiError carries `status`). A network or auth failure leaves
 * the link ACTIVE and propagates — we never guess deletion from an error we
 * don't understand.
 */
async function resolveLinks(
  userId: string,
  links: Array<{ eventId: string; calendarId: string; role?: "ORGANIZER" | "GUEST" }>,
): Promise<ThreadMeeting[]> {
  if (links.length === 0) return [];

  const cached = await db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.userId, userId));

  // Resolved once for the whole list. Failure is not fatal: without it the
  // RSVP control simply reads as unanswered, which is a smaller wrong than
  // refusing to show the meeting at all.
  const selfEmail = await getAccountEmail(userId).catch(() => null);

  const byEventId = new Map(cached.map((row) => [row.eventId, row]));
  const resolved: ThreadMeeting[] = [];

  for (const link of links) {
    const row = byEventId.get(link.eventId);

    if (row) {
      if (row.status === "cancelled") {
        // Google told us via the webhook. Authoritative, no extra call needed.
        await closeThreadLink(
          userId,
          link.calendarId,
          link.eventId,
          "DELETED_EXTERNALLY",
        );
        continue;
      }
      resolved.push({
        eventId: link.eventId,
        calendarId: link.calendarId,
        title: row.title,
        start: row.startTime.toISOString(),
        end: row.endTime.toISOString(),
        attendees: extractAttendees(row.attendees),
        htmlLink: row.htmlLink ?? undefined,
        meetLink: row.meetLink ?? undefined,
        location: row.location ?? undefined,
        description: row.description ?? undefined,
        organizerEmail: row.organizerEmail ?? undefined,
        myResponseStatus: extractMyResponse(row.attendees, selfEmail),
        role: link.role ?? "ORGANIZER",
      });
      continue;
    }

    // No local row — the only safe way to tell "not synced yet" from "gone".
    try {
      const live = await getEvent(userId, link.eventId);
      if (live.status === "cancelled") {
        await closeThreadLink(
          userId,
          link.calendarId,
          link.eventId,
          "DELETED_EXTERNALLY",
        );
        continue;
      }
      resolved.push({
        eventId: link.eventId,
        calendarId: link.calendarId,
        title: live.title,
        start: live.start,
        end: live.end,
        attendees: live.attendees ?? [],
        htmlLink: live.htmlLink,
        meetLink: live.meetLink,
        location: live.location,
        description: live.description,
        organizerEmail: live.organizerEmail,
        myResponseStatus: live.myResponseStatus,
        role: link.role ?? "ORGANIZER",
      });
    } catch (error) {
      if (isNotFound(error)) {
        await closeThreadLink(
          userId,
          link.calendarId,
          link.eventId,
          "DELETED_EXTERNALLY",
        );
        continue;
      }
      // Anything else is our problem, not evidence of a deletion.
      throw error;
    }
  }

  return resolved;
}

/**
 * Active meetings for a thread, newest-scheduled first.
 *
 * Ordering is by `createdAt` desc — most recently scheduled, not
 * earliest-starting. A thread holding a Monday meeting and a Friday meeting
 * has no "next" meeting in any useful sense, but it does have one the user
 * just made, and that is the one a banner should be talking about.
 */
export async function getActiveThreadMeetings(
  userId: string,
  threadId: string,
): Promise<ThreadMeeting[]> {
  const { meetings } = await resolveThreadMeetings(userId, threadId);
  return meetings;
}

/**
 * As `getActiveThreadMeetings`, but says *why* the list is empty.
 *
 * The single seam where "this user's meetings for this thread" is decided,
 * covering both the organiser (who has link rows) and a guest (who never
 * will). Callers get the answer without needing to know which side produced
 * it, or whether it came from the local cache or from Google.
 */
export async function resolveThreadMeetings(
  userId: string,
  threadId: string,
): Promise<{ meetings: ThreadMeeting[]; resolution: GuestResolution }> {
  // Every link for this thread, ACTIVE or not. The status filter used to live
  // in SQL, which meant the closed rows were invisible here — and a closed row
  // is exactly what the guest lookup below has to be checked against.
  const allLinks = await db
    .select({
      eventId: threadCalendarEvents.eventId,
      calendarId: threadCalendarEvents.calendarId,
      role: threadCalendarEvents.role,
      status: threadCalendarEvents.status,
    })
    .from(threadCalendarEvents)
    .where(
      and(
        eq(threadCalendarEvents.userId, userId),
        eq(threadCalendarEvents.threadId, threadId),
      ),
    )
    .orderBy(desc(threadCalendarEvents.createdAt));

  const links = allLinks
    .filter((l) => l.status === "ACTIVE")
    .map(({ status: _status, ...rest }) => rest);

  /**
   * Event ids this user has already closed on this thread.
   *
   * The guest lookup must never hand one of these back. A cancelled meeting
   * that reappears is bad enough; it reappears with role GUEST, which takes the
   * Cancel and Reschedule buttons away from the organiser who just cancelled
   * it, leaving them no way to remove it at all.
   *
   * Safe because an event id is never reused for a different meeting (see the
   * status note on `threadCalendarEvents`), so suppressing a closed id cannot
   * hide a genuinely new one.
   */
  const closedEventIds = new Set(
    allLinks.filter((l) => l.status !== "ACTIVE").map((l) => l.eventId),
  );

  // An ORGANISER's links are complete by construction: a row is written at
  // creation for every meeting they schedule, so there is nothing a join could
  // add and no reason to pay for one.
  const hasGuestLink = links.some((l) => l.role === "GUEST");
  if (links.length > 0 && !hasGuestLink) {
    return { meetings: await resolveLinks(userId, links), resolution: "none" };
  }

  // A GUEST's links are only ever as complete as the last join that produced
  // them, so holding one must NOT stop the join running again. It used to:
  // the first view linked the meeting that existed then, every later view took
  // the links path above, and a second meeting scheduled afterwards was
  // invisible to the guest forever while the organiser saw both. The join is
  // TTL-bounded (see LOOKUP_TTL_MS), not free-running.
  const guest = await findGuestThreadMeetings(userId, threadId);

  // Links we already hold, plus anything the join just found. Existing rows
  // keep their position, so newest-scheduled-first ordering survives.
  const known = new Map(links.map((l) => [l.eventId, l]));
  for (const eventId of guest.eventIds) {
    if (known.has(eventId)) continue;
    // Closed here deliberately — do not revive it. See `closedEventIds`.
    if (closedEventIds.has(eventId)) continue;
    known.set(eventId, {
      eventId,
      calendarId: DEFAULT_CALENDAR_ID,
      role: "GUEST" as const,
    });

    // Make it durable, so the card survives the next lookup failure.
    try {
      await linkThreadEvent({ userId, threadId, eventId, role: "GUEST" });
    } catch (error) {
      // A meeting we found but failed to link is still a meeting to show; it
      // just costs another lookup next time.
      console.error("[thread-links] failed to persist guest link", {
        userId,
        threadId,
        eventId,
        error: String(error),
      });
    }
  }

  if (known.size === 0) {
    return { meetings: [], resolution: guest.resolution };
  }

  const meetings = await resolveLinks(userId, [...known.values()]);
  return { meetings, resolution: "guest-linked" };
}

/**
 * The meeting a UI banner should describe, or null.
 *
 * **UI seeding only.** Newest-wins is an arbitrary rule, and it is safe here
 * only because the banner shows the user which meeting it picked and lets them
 * change it. Never call this from a write path — that is what
 * `resolveWriteTarget` is for.
 *
 * This is also the single place "which meeting is the thread's meeting" is
 * decided, so introducing an explicit isPrimary/sequenceNumber later is a
 * one-function change rather than a hunt through call sites.
 */
export async function getPrimaryMeeting(
  userId: string,
  threadId: string,
): Promise<ThreadMeeting | null> {
  const meetings = await getActiveThreadMeetings(userId, threadId);
  return meetings[0] ?? null;
}

/**
 * The newest deletion the user hasn't dismissed yet, or null.
 *
 * This — and not "did this request just detect a deletion" — is what drives
 * the warning banner. The latter is true exactly once: React Query refetches
 * on window focus and after every invalidation, and the second call would find
 * the link already stamped and report nothing, making the one warning this
 * feature exists to deliver vanish on its own.
 */
export async function getUnacknowledgedDeletion(
  userId: string,
  threadId: string,
): Promise<ThreadMeetingRef | null> {
  const [link] = await db
    .select({
      eventId: threadCalendarEvents.eventId,
      calendarId: threadCalendarEvents.calendarId,
      title: calendarEvents.title,
      startTime: calendarEvents.startTime,
    })
    .from(threadCalendarEvents)
    .leftJoin(
      calendarEvents,
      // Both halves of the key: (userId, eventId) is what identifies one user's
      // copy of an event. Joining on eventId alone matched every attendee's row
      // and multiplied the result.
      and(
        eq(calendarEvents.userId, threadCalendarEvents.userId),
        eq(calendarEvents.eventId, threadCalendarEvents.eventId),
      ),
    )
    .where(
      and(
        eq(threadCalendarEvents.userId, userId),
        eq(threadCalendarEvents.threadId, threadId),
        eq(threadCalendarEvents.status, "DELETED_EXTERNALLY"),
        isNull(threadCalendarEvents.acknowledgedAt),
      ),
    )
    .orderBy(desc(threadCalendarEvents.closedAt))
    .limit(1);

  if (!link) return null;

  // The joined row is usually already gone — syncCalendarEvents deletes what
  // Google no longer returns — so the title is best-effort by design.
  return {
    eventId: link.eventId,
    calendarId: link.calendarId,
    title: link.title ?? "the meeting scheduled from this thread",
    start: link.startTime?.toISOString() ?? "",
  };
}

// ── Meeting lifecycle ─────────────────────────────────────────────────

// Re-exported, not redefined: the rule itself lives in @repo/shared so the
// thread card can ask the same question this file's write guards ask. A second
// copy here is how a card comes to offer a Reschedule button that the resolver
// then refuses.
export { isUpcomingMeeting, partitionMeetingsByTime } from "@repo/shared/calendar";

/**
 * The thread's meetings that scheduling decisions are allowed to see.
 *
 * This — not `getActiveThreadMeetings` — is what the precheck and the write
 * resolver read. "Schedule a meeting with John" means create one; a meeting
 * that ended yesterday must not turn that into "you already have one, shall I
 * move it?", which is the entire bug this exists to close.
 */
export async function getUpcomingThreadMeetings(
  userId: string,
  threadId: string,
): Promise<ThreadMeeting[]> {
  const meetings = await getActiveThreadMeetings(userId, threadId);
  return partitionMeetingsByTime(meetings).upcoming;
}

// ── Write targeting ───────────────────────────────────────────────────

export type WriteTarget =
  | { kind: "none" }
  /**
   * The thread has meetings, but every one of them is over. Distinct from
   * "none" because the two deserve different sentences and because collapsing
   * them would leave the user's own history looking like it never existed.
   * Never a licence to move the past meeting — there is no useful sense in
   * which something that already ended can be rescheduled. If the user wants
   * to meet again, that is a NEW meeting.
   */
  | { kind: "past-only"; meetings: ThreadMeeting[] }
  | { kind: "one"; meeting: ThreadMeeting }
  | { kind: "ambiguous"; meetings: ThreadMeeting[] };

/**
 * Resolve a `selectionId` the model copied from a list back to a meeting.
 *
 * Matching happens against the thread's *current* active meetings, so a token
 * naming a meeting that has since been cancelled resolves to `notFound` rather
 * than to whatever now sits in its old position — the failure the whole token
 * scheme exists to make impossible.
 */
export type SelectionResult =
  | { kind: "found"; meeting: ThreadMeeting }
  | { kind: "notFound"; meetings: ThreadMeeting[] }
  /**
   * The token resolved, and it names a meeting that is over. Its own case
   * rather than folding into `notFound`: the meeting demonstrably exists and
   * saying "no meeting matches that" about something the user can see on the
   * thread would be a lie told by a safety check.
   */
  | { kind: "past"; meeting: ThreadMeeting };

export async function resolveSelection(
  userId: string,
  threadId: string,
  selectionId: string,
): Promise<SelectionResult> {
  const meetings = await getActiveThreadMeetings(userId, threadId);
  const match = meetings.find((m) => selectionIdFor(m.eventId) === selectionId);
  if (!match) return { kind: "notFound", meetings };
  if (!isUpcomingMeeting(match)) return { kind: "past", meeting: match };
  return { kind: "found", meeting: match };
}

export type SelectionDrift = "missing" | "changed" | null;

/**
 * Does `expectedStart` (what a prior listing showed) still match
 * `actualStart` (the meeting's current start)?
 *
 * `selectionId` is a stable hash of the event id, so it survives a reschedule
 * of the SAME event — it keeps resolving fine even though what the model told
 * the user is now stale. This is the other half of drift detection: the token
 * only catches cancellation (it stops matching anything); this catches a
 * same-event time change, by comparing against what was actually shown.
 *
 * "missing" and "changed" are refused identically by callers, on purpose:
 * both mean the server cannot prove this is the meeting the user was shown —
 * a hole in the safety record is not "nothing to check", it is its own
 * failure mode. `expectedStart` is `undefined` when no `getThreadMeetings`
 * ledger entry exists for this conversation to compare against (see
 * `apps/web/lib/assistant/tool-memory.ts`'s `MeetingSelectionRef`).
 *
 * Pure and total — no I/O — so it is testable without any of the DB/ledger
 * plumbing that produces its inputs.
 */
export function checkSelectionDrift(
  expectedStart: string | undefined,
  actualStart: string,
): SelectionDrift {
  if (expectedStart === undefined) return "missing";
  if (expectedStart !== actualStart) return "changed";
  return null;
}

/**
 * The only entry point for rescheduling or cancelling a thread's meeting.
 *
 * There is deliberately no "newest" branch. A write path cannot silently pick
 * the wrong meeting because the type gives it nothing to pick from: with more
 * than one active meeting the caller receives the list and has to ask. Newest
 * -wins is fine for a banner the user can see and override; it is not fine for
 * an irreversible action approved sight-unseen.
 */
export async function resolveWriteTarget(
  userId: string,
  threadId: string,
): Promise<WriteTarget> {
  const meetings = await getActiveThreadMeetings(userId, threadId);
  if (meetings.length === 0) return { kind: "none" };

  // Past meetings are not candidates. Ambiguity is counted AFTER this split,
  // which is the point: a thread holding yesterday's call and tomorrow's is
  // not ambiguous, it has exactly one meeting left to move.
  const { upcoming } = partitionMeetingsByTime(meetings);
  if (upcoming.length === 0) return { kind: "past-only", meetings };
  if (upcoming.length === 1) return { kind: "one", meeting: upcoming[0]! };
  return { kind: "ambiguous", meetings: upcoming };
}

/**
 * Can this user WRITE to this event — move it, cancel it — or only see it?
 *
 * Exists because `userOwnsEvent` below answers a different, weaker question
 * ("is this event in your calendar at all?") and was never a write guard —
 * true for an invited attendee just as much as the organiser. The assistant's
 * tools have their own guard (`refuseIfGuest` in
 * `apps/web/lib/executors/calendar.ts`, checking `ThreadMeeting.role`), but
 * the `/calendar` page's `update`/`delete` tRPC mutations called `updateEvent`/
 * `deleteEvent` directly with no check at all — any signed-in user could move
 * or cancel any event their own `calendar_events` cache happened to contain,
 * including ones they were only invited to. Confirmed as a real bug: a guest
 * rescheduling a thread-linked meeting from `/calendar` succeeded on THEIR OWN
 * calendar but never propagated to the organiser's — Google silently scoping
 * the write to the requester's copy rather than the shared event, which is
 * arguably worse than an outright rejection because both calendars now
 * disagree with no one told.
 *
 * Three sources, most authoritative first:
 *   1. `thread_calendar_events.role`, when this event is thread-linked — the
 *      fact this whole feature exists to make correct.
 *   2. `calendar_events.organizerEmail` vs. the signed-in account's own
 *      address, for events with no thread link at all (created outside
 *      Mailroid, or linked to a thread this user never opened here).
 *   3. A live Google Calendar lookup, when neither local source has an
 *      opinion (an event never synced locally, or a stale/deleted row) — the
 *      one case this used to return "UNKNOWN" and let the caller allow the
 *      write on no evidence at all. It no longer does: "UNKNOWN" now only
 *      happens after this live lookup has also failed to produce an answer —
 *      ownership could not be established, and callers don't need to know
 *      why, only that they cannot safely authorize the write — so it must be
 *      treated as a refusal, not a pass. A genuine lookup error
 *      (network/auth/unexpected) is intentionally NOT mapped to "UNKNOWN" —
 *      it propagates as a thrown error instead, so an infra problem surfaces
 *      as an infra problem rather than masquerading as an ordinary permission
 *      decision (the route layer turns it into a clean user-facing refusal).
 *      A write with no evidence for "you may do this" is a bigger risk than a
 *      rare false-positive refusal, which the user can just retry.
 */
export async function getEventWriteRole(
  userId: string,
  eventId: string,
): Promise<"ORGANIZER" | "GUEST" | "UNKNOWN"> {
  const [link] = await db
    .select({ role: threadCalendarEvents.role })
    .from(threadCalendarEvents)
    .where(
      and(
        eq(threadCalendarEvents.userId, userId),
        eq(threadCalendarEvents.eventId, eventId),
      ),
    )
    .orderBy(desc(threadCalendarEvents.createdAt))
    .limit(1);

  if (link) return link.role;

  const [row] = await db
    .select({ organizerEmail: calendarEvents.organizerEmail })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        eq(calendarEvents.eventId, eventId),
      ),
    )
    .limit(1);

  const selfEmail = (await getAccountEmail(userId)).toLowerCase();

  if (row?.organizerEmail) {
    return row.organizerEmail.toLowerCase() === selfEmail ? "ORGANIZER" : "GUEST";
  }

  // No local evidence at all. Ask Google directly rather than guessing — a
  // genuine error here is deliberately left to propagate (see JSDoc above).
  const lookup = await getEventOrganizerEmail(userId, eventId);
  if (lookup.status === "NOT_FOUND" || !lookup.email) return "UNKNOWN";

  // Backfill the local cache now that we have authoritative data, regardless
  // of which way the decision goes — a cached GUEST answer is exactly as
  // useful as a cached ORGANIZER one, and both save the live call on the next
  // write to this event. Only ever an UPDATE of an existing row's
  // organizer_email — never an INSERT, since we don't have title/start/end
  // here and that column set is NOT NULL. A no-op when there's no local
  // `calendar_events` row for this event at all yet.
  await db
    .update(calendarEvents)
    .set({ organizerEmail: lookup.email })
    .where(and(eq(calendarEvents.userId, userId), eq(calendarEvents.eventId, eventId)));

  return lookup.email.toLowerCase() === selfEmail ? "ORGANIZER" : "GUEST";
}

/**
 * Does this event belong to this user? Defence in depth behind the tool
 * schemas, which never accept an eventId in the first place.
 */
export async function userOwnsEvent(
  userId: string,
  eventId: string,
): Promise<boolean> {
  const [link] = await db
    .select({ id: threadCalendarEvents.id })
    .from(threadCalendarEvents)
    .where(
      and(
        eq(threadCalendarEvents.userId, userId),
        eq(threadCalendarEvents.eventId, eventId),
      ),
    )
    .limit(1);
  if (link) return true;

  const [row] = await db
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        eq(calendarEvents.eventId, eventId),
      ),
    )
    .limit(1);
  return !!row;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Corsair's ApiError carries the HTTP status; anything else isn't a 404. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  );
}

/** `calendar_events.attendees` holds raw Google attendee objects. */
function extractAttendees(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) =>
      typeof a === "object" && a !== null && "email" in a
        ? (a as { email?: unknown }).email
        : undefined,
    )
    .filter((e): e is string => typeof e === "string");
}

/** The four values Google uses; anything else is treated as unknown. */
const RESPONSE_STATUSES = ["needsAction", "accepted", "declined", "tentative"] as const;
type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

/**
 * This user's own RSVP out of the stored attendee blob.
 *
 * `calendar_events.attendees` holds Google's attendee objects verbatim, so the
 * answer is already local — no extra API call to show a guest what they last
 * replied.
 */
function extractMyResponse(raw: unknown, selfEmail: string | null): ResponseStatus | undefined {
  if (!Array.isArray(raw)) return undefined;
  const selfLower = selfEmail?.toLowerCase();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const a = entry as { email?: unknown; self?: unknown; responseStatus?: unknown };
    const isSelf =
      a.self === true ||
      (!!selfLower && typeof a.email === "string" && a.email.toLowerCase() === selfLower);
    if (!isSelf) continue;
    const status = a.responseStatus;
    return RESPONSE_STATUSES.includes(status as ResponseStatus)
      ? (status as ResponseStatus)
      : undefined;
  }
  return undefined;
}
