import { db, and, eq, desc, isNull } from "@repo/database";
import { calendarEvents } from "@repo/database/models/calendar-events";
import { threadCalendarEvents } from "@repo/database/models/thread-calendar-events";

import { getEvent } from "./index.ts";

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

export interface ThreadMeeting {
  eventId: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  htmlLink?: string;
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
  links: Array<{ eventId: string; calendarId: string }>,
): Promise<ThreadMeeting[]> {
  if (links.length === 0) return [];

  const cached = await db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.userId, userId));

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
  const links = await db
    .select({
      eventId: threadCalendarEvents.eventId,
      calendarId: threadCalendarEvents.calendarId,
    })
    .from(threadCalendarEvents)
    .where(
      and(
        eq(threadCalendarEvents.userId, userId),
        eq(threadCalendarEvents.threadId, threadId),
        eq(threadCalendarEvents.status, "ACTIVE"),
      ),
    )
    .orderBy(desc(threadCalendarEvents.createdAt));

  return resolveLinks(userId, links);
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
      eq(calendarEvents.eventId, threadCalendarEvents.eventId),
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

// ── Write targeting ───────────────────────────────────────────────────

export type WriteTarget =
  | { kind: "none" }
  | { kind: "one"; meeting: ThreadMeeting }
  | { kind: "ambiguous"; meetings: ThreadMeeting[] };

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
  if (meetings.length === 1) return { kind: "one", meeting: meetings[0]! };
  return { kind: "ambiguous", meetings };
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
