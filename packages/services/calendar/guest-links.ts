import { db, and, asc, eq, inArray, gt, isNotNull, lt, ne, sql } from "@repo/database";
import { calendarEvents } from "@repo/database/models/calendar-events";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { threadMeetingLookups } from "@repo/database/models/thread-meeting-lookups";
import { corsair } from "@repo/corsair";

import { THREAD_ROOT_MSG_ID_KEY } from "../gmail/thread-headers.ts";
import { hashMessageIdForCalendar } from "../gmail/message-id.ts";

/**
 * Finding a meeting from the GUEST's side.
 *
 * The organiser's path is simple: they scheduled the meeting, so a
 * `thread_calendar_events` row links their thread to the event. A guest has no
 * such row and never will — their Gmail thread id is assigned by their own
 * mailbox and will essentially never equal the organiser's for "the same"
 * conversation.
 *
 * What the two DO share is the RFC822 `Message-ID` of the messages themselves,
 * which is why events are stamped with the thread's root Message-ID at
 * creation (see gmail/thread-headers.ts). This module walks that join
 * backwards: the guest's thread → its Message-IDs → an event carrying one of
 * them.
 *
 * Resolution is cache-first, then remote:
 *
 *     local calendar_events  →  miss?  →  Google  →  cache  →  return
 *
 * `calendar_events` is only a −7d/+30d sync cache, so a miss there is not an
 * answer. Deliberately NOT solved by widening that window: correctness would
 * then depend on a cache-warming policy, and every watch-triggered sync would
 * do bulk work on the chance that someone opens one thread. This way the cost
 * is proportional to threads actually opened, and — because a hit writes a
 * durable link — it is paid at most once per thread.
 */

/**
 * How long an answer from Google suppresses the next remote call.
 *
 * Written after EVERY completed lookup, not only empty ones. It used to mark
 * "there is nothing here", which was enough while a thread could show only one
 * meeting: once one was found and linked, the join never ran again. A thread
 * can hold several, and a second one scheduled later has to be findable — so
 * the join now runs on every guest thread view and this is what keeps that
 * affordable.
 */
const LOOKUP_TTL_MS = 15 * 60 * 1000;

/**
 * Why a thread has no meeting to show. `meetings: []` alone cannot distinguish
 * "there is none" from "we couldn't tell", and rendering the second as the
 * first is the silent-degradation failure this codebase keeps relearning.
 */
export type GuestResolution =
  /** Checked, including against Google. There is genuinely no meeting. */
  | "none"
  /** Found via the guest join; the caller is an attendee, not the organiser. */
  | "guest-linked"
  /** This thread has no captured Message-IDs, so the join cannot even be attempted. */
  | "unindexed"
  /** The remote lookup failed. We do not know, and must not claim to. */
  | "lookup-failed";

export interface GuestLookupResult {
  /** Events found for this user, ready to be linked and resolved normally. */
  eventIds: string[];
  resolution: GuestResolution;
}

/** Every Message-ID we hold for a thread, oldest first. */
async function threadMessageIds(userId: string, threadId: string): Promise<string[]> {
  const rows = await db
    .select({ rfc822MessageId: messageMetadata.rfc822MessageId })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.threadId, threadId),
        isNotNull(messageMetadata.rfc822MessageId),
        // '' is the backfill's "checked, nothing to store" marker, not an id.
        ne(messageMetadata.rfc822MessageId, ""),
      ),
    )
    // Oldest first: events are stamped with the thread ROOT, so the remote
    // lookup below needs the earliest id we hold.
    .orderBy(asc(messageMetadata.receivedAt));

  return rows.map((r) => r.rfc822MessageId!).filter(Boolean);
}

/** True when Google was asked about this thread recently enough to trust. */
async function hasFreshLookup(userId: string, threadId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: threadMeetingLookups.id })
    .from(threadMeetingLookups)
    .where(
      and(
        eq(threadMeetingLookups.userId, userId),
        eq(threadMeetingLookups.threadId, threadId),
        gt(threadMeetingLookups.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return !!row;
}

async function writeLookupMarker(userId: string, threadId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(threadMeetingLookups)
    .values({
      userId,
      threadId,
      checkedAt: now,
      expiresAt: new Date(now.getTime() + LOOKUP_TTL_MS),
    })
    .onConflictDoUpdate({
      target: [threadMeetingLookups.userId, threadMeetingLookups.threadId],
      set: {
        checkedAt: now,
        expiresAt: new Date(now.getTime() + LOOKUP_TTL_MS),
      },
    });
}

/**
 * Drop negative markers, so the next thread view re-checks.
 *
 * Called on the two signals that can invalidate a "nothing here" answer: this
 * user's calendar changed (they were invited to something), or new mail landed
 * on a thread (its Message-ID set may have grown). The TTL is only a backstop
 * for what neither signal catches — relying on it alone would leave a guest
 * reading "no meeting" for minutes after they were actually invited.
 */
export async function clearThreadMeetingLookups(
  userId: string,
  threadId?: string,
): Promise<void> {
  try {
    await db
      .delete(threadMeetingLookups)
      .where(
        threadId
          ? and(
              eq(threadMeetingLookups.userId, userId),
              eq(threadMeetingLookups.threadId, threadId),
            )
          : eq(threadMeetingLookups.userId, userId),
      );
  } catch (error) {
    // A cache we failed to clear costs at most one stale TTL window. It must
    // never take down the sync or ingest path that called it.
    console.error("[guest-links] failed to clear lookup markers", {
      userId,
      threadId,
      error: String(error),
    });
  }
}

/** Best-effort sweep of expired rows, so the table cannot grow without bound. */
export async function pruneExpiredThreadMeetingLookups(): Promise<void> {
  await db.delete(threadMeetingLookups).where(lt(threadMeetingLookups.expiresAt, new Date()));
}

/**
 * Ask Google directly whether any event carries one of these Message-IDs.
 *
 * One request, not one per id: events are stamped with the thread ROOT only,
 * so a single `key=value` filter covers it. That matters because Google ANDs
 * repeated `sharedExtendedProperty` params — several ids could not be ORed in
 * one call, and this sits on a page-load path.
 *
 * `sharedExtendedProperty` is not declared in the Corsair plugin's input type;
 * it is forwarded because the endpoint passes its whole input as the query
 * object. Verified against real Google by `pnpm admin calendar:probe-shared-props`.
 *
 * The filter value must be the HASH (`hashMessageIdForCalendar`), matching
 * what events are actually stamped with — the same probe found that Google's
 * filter silently fails to match a raw Message-ID once it contains the `+`/
 * `=` characters most real ones do, even though the raw value writes and
 * reads back fine everywhere else. Passing the raw id here would reproduce
 * exactly that bug: a lookup that finds nothing for a thread that has a
 * meeting, with no error anywhere.
 */
async function remoteLookup(userId: string, rootMessageId: string): Promise<string[]> {
  const tenant = corsair.withTenant(userId);

  // Deliberately much wider than the sync window — the entire point of the
  // remote path is to find meetings the local cache was never going to hold.
  const timeMin = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  const response = (await tenant.googlecalendar.api.events.getMany({
    sharedExtendedProperty: `${THREAD_ROOT_MSG_ID_KEY}=${hashMessageIdForCalendar(rootMessageId)}`,
    timeMin,
    timeMax,
    singleEvents: true,
    maxResults: 50,
  } as Parameters<typeof tenant.googlecalendar.api.events.getMany>[0])) as unknown as {
    items?: Array<{ id?: string; status?: string }>;
  };

  return (response.items ?? [])
    .filter((e) => e.id && e.status !== "cancelled")
    .map((e) => e.id!);
}

/**
 * Resolve a thread to meetings the user was invited to but never scheduled.
 *
 * Returns event ids only; linking and hydration stay with the caller
 * (`thread-links.ts`), which already owns both.
 */
export async function findGuestThreadMeetings(
  userId: string,
  threadId: string,
): Promise<GuestLookupResult> {
  const messageIds = await threadMessageIds(userId, threadId);

  // No captured Message-IDs — mail synced before the header was stored, or a
  // thread whose messages genuinely carry none. The join is not possible, and
  // saying "no meeting" would be a claim we have not earned.
  if (messageIds.length === 0) {
    return { eventIds: [], resolution: "unindexed" };
  }

  // ── Warm path: purely local ─────────────────────────────────────────
  // `calendar_events.threadMessageId` is synced verbatim from Google's
  // extendedProperties.shared, which now holds the HASH (see remoteLookup's
  // doc comment) — so the comparison must hash `messageIds` too, not compare
  // them raw. Every id is hashed, not just the root, so the warm path still
  // matches on whichever message a differently-scoped stamp used, same as it
  // did before hashing was introduced.
  const hashedMessageIds = messageIds.map(hashMessageIdForCalendar);
  const cached = await db
    .select({ eventId: calendarEvents.eventId })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        inArray(calendarEvents.threadMessageId, hashedMessageIds),
        sql`(${calendarEvents.status} IS NULL OR ${calendarEvents.status} <> 'cancelled')`,
      ),
    );

  const localIds = cached.map((r) => r.eventId);

  // A local hit is deliberately NOT an early return. `calendar_events` is a
  // −7d/+30d sync cache, so holding one of a thread's meetings is no evidence
  // it holds them all — the second one may be outside the window, or simply
  // not synced yet. Returning here is what made a guest see one card while the
  // organiser saw two.
  if (await hasFreshLookup(userId, threadId)) {
    return {
      eventIds: localIds,
      resolution: localIds.length > 0 ? "guest-linked" : "none",
    };
  }

  // ── Cold path: ask Google ───────────────────────────────────────────
  // Only the oldest id is queryable, because that is what events are stamped
  // with. A guest added midway through a thread may not hold the root at all,
  // which is a real limit of the mechanism rather than an error.
  const rootMessageId = messageIds[0];
  if (!rootMessageId) {
    return {
      eventIds: localIds,
      resolution: localIds.length > 0 ? "guest-linked" : "unindexed",
    };
  }

  try {
    const remoteIds = await remoteLookup(userId, rootMessageId);

    // Marked on success as well as on empty. The marker now means "recently
    // asked", not "recently found nothing" — see LOOKUP_TTL_MS.
    await writeLookupMarker(userId, threadId);

    // Union, not replace. Google is authoritative for what exists, but the
    // remote filter matches only the thread ROOT stamp, while the warm path
    // matches any of the thread's Message-IDs — so each can hold something the
    // other misses, and dropping either would reintroduce a missing card.
    const merged = [...new Set([...localIds, ...remoteIds])];

    return {
      eventIds: merged,
      resolution: merged.length > 0 ? "guest-linked" : "none",
    };
  } catch (error) {
    // No marker on failure: caching "nothing" because the request broke would
    // turn a transient outage into fifteen minutes of confidently telling the
    // user there is no meeting.
    console.error("[guest-links] remote lookup failed", {
      userId,
      threadId,
      error: String(error),
    });

    // Whatever the cache holds still beats showing nothing. Known limit: this
    // cannot say "and there may be more" — `GuestResolution` has no partial
    // state, so a thread with two meetings and a broken lookup shows the one
    // that happened to be cached.
    return localIds.length > 0
      ? { eventIds: localIds, resolution: "guest-linked" }
      : { eventIds: [], resolution: "lookup-failed" };
  }
}
