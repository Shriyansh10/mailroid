/**
 * When does a meeting stop being a thing you can act on?
 *
 * Lives in @repo/shared, not in the calendar service, because both sides of
 * the wire have to agree. The server refuses a write against a finished
 * meeting; the thread card has to stop OFFERING that write in the first place,
 * or the product's answer to "reschedule this" is a button that exists purely
 * to be refused. One function, imported by both — the same reason
 * `resolveAddMeet` sits next door.
 */

/**
 * Is this meeting still ahead of us?
 *
 * END time, not start: a meeting that began an hour ago and runs for another
 * thirty minutes is still the meeting you would move if you said "push it
 * back". A meeting whose end has passed is over, and this deliberately does
 * not ask whether it actually happened — attendance is unknowable here and
 * irrelevant to the question. If Google says 3–4pm yesterday, it is over.
 *
 * The asymmetry that matters: this is used to decide what a WRITE may touch
 * and what BLOCKS a new booking, never what the thread displays. A meeting
 * that ended an hour ago is still part of the conversation's history and the
 * thread card must keep showing it — see `getActiveThreadMeetings`, which
 * stays unfiltered on purpose.
 *
 * Pure and total — no I/O — so the rule is testable without any of the
 * database plumbing that produces its inputs.
 */
export function isUpcomingMeeting(
  meeting: { end: string },
  now: Date = new Date(),
): boolean {
  const end = Date.parse(meeting.end);

  // An end time we cannot read is treated as UPCOMING, not as past. Both
  // answers are wrong, but they fail in opposite directions: "past" would let
  // a duplicate meeting be booked over a live one and fire a second invite at
  // every attendee, while "upcoming" at worst makes us ask the user a question
  // they did not need. Ask, never assume — the same reason the precheck
  // refuses rather than swallowing a calendar outage.
  if (Number.isNaN(end)) return true;

  return end > now.getTime();
}

/**
 * Split a thread's meetings into the ones a write may act on and the ones that
 * are only history now. Order within each side is preserved.
 */
export function partitionMeetingsByTime<T extends { end: string }>(
  meetings: T[],
  now: Date = new Date(),
): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const meeting of meetings) {
    (isUpcomingMeeting(meeting, now) ? upcoming : past).push(meeting);
  }
  return { upcoming, past };
}

