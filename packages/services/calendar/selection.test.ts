/**
 * Tests for the token that names one of a thread's meetings.
 *
 * These pin the property the whole design rests on: a selectionId must keep
 * meaning the SAME meeting no matter what happens to the list around it.
 *
 * The alternative — letting the model say "meeting 2" — fails precisely when
 * it is hardest to notice. The list is ordered newest-scheduled first, so a
 * meeting created while the user is deciding renumbers everything under them,
 * and "reschedule meeting 2" silently moves a meeting they never looked at.
 * Attendees get the invite either way.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { selectionIdFor, checkSelectionDrift } from "./thread-links.ts";

/** Mirrors resolveSelection's matching, without needing a database. */
function findByToken<T extends { eventId: string }>(
  meetings: T[],
  selectionId: string,
): T | undefined {
  return meetings.find((m) => selectionIdFor(m.eventId) === selectionId);
}

const meeting = (eventId: string, title: string) => ({ eventId, title });

test("the same event always yields the same token", () => {
  assert.equal(selectionIdFor("abc123"), selectionIdFor("abc123"));
});

test("different events yield different tokens", () => {
  const ids = ["abc123", "abc124", "zzz999", "a", "", "AbC123"];
  const tokens = ids.map(selectionIdFor);
  assert.equal(new Set(tokens).size, ids.length, "tokens collided across distinct event ids");
});

test("no real event id leaks into the token", () => {
  // The thread tools deliberately accept no eventId anywhere in their schemas,
  // so an event id pasted into an email body is inexpressible. A token that
  // embedded one would reopen that path.
  const eventId = "7f3k2j9dlm4qp8s1a0";
  assert.ok(!selectionIdFor(eventId).includes(eventId));
});

test("a token survives another meeting being scheduled — the ordinal failure", () => {
  // Newest-first, as getActiveThreadMeetings returns them.
  const before = [meeting("evt-b", "Follow-up"), meeting("evt-a", "Design review")];
  const token = selectionIdFor("evt-a"); // the user picked "Design review"

  // Someone schedules a third meeting while the user is deciding.
  const after = [meeting("evt-c", "Kickoff"), ...before];

  // As an ordinal this was 2, and is now 3 — position 2 is a different meeting.
  assert.equal(before[1]!.title, "Design review");
  assert.equal(after[1]!.title, "Follow-up");

  // The token is unmoved.
  assert.equal(findByToken(after, token)?.title, "Design review");
});

test("a token survives another meeting being cancelled", () => {
  const before = [meeting("evt-c", "Kickoff"), meeting("evt-b", "Follow-up"), meeting("evt-a", "Design review")];
  const token = selectionIdFor("evt-a");

  const after = before.filter((m) => m.eventId !== "evt-c");
  assert.equal(findByToken(after, token)?.title, "Design review");
});

test("a token for a cancelled meeting resolves to nothing, not to its successor", () => {
  // The drift case that matters. The meeting the user chose is gone; the
  // caller must be told to re-list rather than handed whatever now sits in
  // that position — which is what an ordinal would have done.
  const token = selectionIdFor("evt-a");
  const after = [meeting("evt-c", "Kickoff"), meeting("evt-b", "Follow-up")];

  assert.equal(findByToken(after, token), undefined);
});

test("an unknown or invented token matches nothing", () => {
  const meetings = [meeting("evt-a", "Design review")];
  for (const bogus of ["m-0000000", "", "evt-a", "m-guessed"]) {
    assert.equal(findByToken(meetings, bogus), undefined, `matched bogus token ${bogus}`);
  }
});

test("tokens are short and copyable", () => {
  // The model has to reproduce these verbatim; a long opaque blob invites a
  // transcription slip, which would surface as "that meeting no longer exists".
  const token = selectionIdFor("some-google-event-id-that-is-quite-long-000");
  assert.match(token, /^m-[0-9a-z]{7}$/);
});

/**
 * `checkSelectionDrift` — the half of drift detection the token itself can't
 * cover. `selectionIdFor` is derived from the event id, so it keeps resolving
 * fine across a RESCHEDULE of the same event — only a cancellation breaks it.
 * This is what catches "the meeting moved since it was listed" instead.
 */

test("agreeing start times mean no drift", () => {
  assert.equal(checkSelectionDrift("2026-08-05T09:00:00", "2026-08-05T09:00:00"), null);
});

test("a mismatched start time is drift, not a pass", () => {
  assert.equal(checkSelectionDrift("2026-08-05T09:00:00", "2026-08-05T16:00:00"), "changed");
});

test("no expectedStart at all is treated as drift, not skipped", () => {
  // The gap this exists to close: a precheck refusal lists meetings without a
  // prior getThreadMeetings call, so there is no ledger entry to compare
  // against. Missing safety data must refuse the same way stale data does —
  // "we can't check" is not the same claim as "we checked and it's fine".
  assert.equal(checkSelectionDrift(undefined, "2026-08-05T09:00:00"), "missing");
});
