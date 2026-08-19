/**
 * When does a thread's meeting stop being a thing you can act on?
 *
 * The bug: a thread link stays ACTIVE until the meeting is cancelled or
 * deleted externally, and nothing ever retired one for having happened. So a
 * meeting from 3 August still counted as a conflict — "schedule a meeting with
 * John" was answered with "this thread already has a meeting, shall I move
 * it?", offering to drag a call that had already taken place onto a new date
 * and re-invite everyone who attended it.
 *
 * The rule these pin: a meeting is actionable only while its END is in the
 * future. Whether it was actually attended is unknowable here and beside the
 * point — if the calendar says it ended, it ended. Display is NOT filtered by
 * this; the thread keeps its history.
 *
 * Run: pnpm --filter @repo/shared test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isUpcomingMeeting, partitionMeetingsByTime } from "./lifecycle.ts";

/** A fixed "now" so these never depend on when the suite runs. */
const NOW = new Date("2026-08-19T12:00:00.000Z");

const at = (start: string, end: string, title = "Meeting") => ({
  start,
  end,
  title,
});

test("a meeting whose end has passed is over", () => {
  // The reported case: 3 August, still blocking scheduling on 19 August.
  assert.equal(
    isUpcomingMeeting(at("2026-08-03T09:00:00Z", "2026-08-03T10:00:00Z"), NOW),
    false,
  );
  // Yesterday counts too — "did anyone show up" is not part of the question.
  assert.equal(
    isUpcomingMeeting(at("2026-08-18T15:00:00Z", "2026-08-18T16:00:00Z"), NOW),
    false,
  );
});

test("a meeting still running is upcoming — end time, not start", () => {
  // Began 30 minutes ago, runs another 30. This is exactly the meeting someone
  // means by "push it back", so a start-time rule would refuse the one case
  // that most needs to work.
  assert.equal(
    isUpcomingMeeting(at("2026-08-19T11:30:00Z", "2026-08-19T12:30:00Z"), NOW),
    true,
  );
});

test("a meeting that ends exactly now is over", () => {
  assert.equal(
    isUpcomingMeeting(at("2026-08-19T11:00:00Z", "2026-08-19T12:00:00.000Z"), NOW),
    false,
  );
  // One millisecond later is not.
  assert.equal(
    isUpcomingMeeting(at("2026-08-19T11:00:00Z", "2026-08-19T12:00:00.001Z"), NOW),
    true,
  );
});

test("an unreadable end time is treated as upcoming, never as past", () => {
  // Both answers are wrong; they fail in opposite directions. "Past" would let
  // a second meeting be booked over a live one and fire a duplicate invite at
  // every attendee. "Upcoming" costs the user one question they did not need.
  assert.equal(isUpcomingMeeting(at("2026-08-19T11:00:00Z", ""), NOW), true);
  assert.equal(isUpcomingMeeting(at("2026-08-19T11:00:00Z", "not a date"), NOW), true);
});

test("partition splits without reordering either side", () => {
  const meetings = [
    at("2026-08-21T09:00:00Z", "2026-08-21T10:00:00Z", "Kickoff"),
    at("2026-08-03T09:00:00Z", "2026-08-03T10:00:00Z", "Old sync"),
    at("2026-08-20T09:00:00Z", "2026-08-20T10:00:00Z", "Design review"),
    at("2026-08-18T09:00:00Z", "2026-08-18T10:00:00Z", "Older sync"),
  ];

  const { upcoming, past } = partitionMeetingsByTime(meetings, NOW);

  // Newest-scheduled-first ordering is what getActiveThreadMeetings returns
  // and what selectionIds are read back against; the split must not disturb it.
  assert.deepEqual(upcoming.map((m) => m.title), ["Kickoff", "Design review"]);
  assert.deepEqual(past.map((m) => m.title), ["Old sync", "Older sync"]);
});

test("a thread holding only finished meetings has nothing to act on", () => {
  // Drives WriteTarget's "past-only" branch: not the same as "none", because
  // the user can still see these on the thread and being told no meeting
  // exists would read as a bug rather than as a refusal.
  const { upcoming, past } = partitionMeetingsByTime(
    [at("2026-08-03T09:00:00Z", "2026-08-03T10:00:00Z", "Old sync")],
    NOW,
  );
  assert.equal(upcoming.length, 0);
  assert.equal(past.length, 1);
});

test("yesterday's meeting plus tomorrow's is not ambiguous", () => {
  // Ambiguity is counted after the split. Before this, a thread with one dead
  // meeting and one live one made "reschedule it" ask which — a question with
  // only one real answer.
  const { upcoming } = partitionMeetingsByTime(
    [
      at("2026-08-20T09:00:00Z", "2026-08-20T10:00:00Z", "Tomorrow"),
      at("2026-08-18T09:00:00Z", "2026-08-18T10:00:00Z", "Yesterday"),
    ],
    NOW,
  );
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0]!.title, "Tomorrow");
});
