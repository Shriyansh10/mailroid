/**
 * The default-Meet rule, pinned.
 *
 * The bug these guard against is not "wrong default" — it is two surfaces
 * reaching different answers from the same arguments, so that an approval card
 * reads "Google Meet: no" and a join link goes out to every guest anyway.
 * Every case below is therefore about agreement first and the default second.
 *
 * Run: pnpm --filter @repo/shared test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveAddMeet } from "./meet.ts";

test("an explicit choice is never overridden", () => {
  // false with guests: the user named a place to meet.
  assert.equal(
    resolveAddMeet({ addMeet: false, attendees: ["a@b.com"] }),
    false,
  );
  // true with nobody: a solo block the user still wants a room for.
  assert.equal(resolveAddMeet({ addMeet: true }), true);
  assert.equal(
    resolveAddMeet({ addMeet: true, attendees: [], attendeeRefs: [] }),
    true,
  );
});

test("silence with guests means yes", () => {
  assert.equal(resolveAddMeet({ attendees: ["a@b.com"] }), true);
  // The model supplies handles, never addresses — this is the live path.
  assert.equal(resolveAddMeet({ attendeeRefs: ["contact_7"] }), true);
  assert.equal(
    resolveAddMeet({ attendees: [], attendeeRefs: ["contact_7"] }),
    true,
  );
});

test("silence with no guests means no", () => {
  assert.equal(resolveAddMeet({}), false);
  assert.equal(resolveAddMeet({ attendees: [], attendeeRefs: [] }), false);
  assert.equal(resolveAddMeet({ title: "Focus block" } as never), false);
});

test("a guest list of empty strings is not a guest list", () => {
  // Reaches this shape from a form that trimmed its last row to "".
  assert.equal(resolveAddMeet({ attendees: ["", "   "] }), false);
  assert.equal(resolveAddMeet({ attendeeRefs: [""] }), false);
});

test("non-boolean addMeet is treated as silence, not as truthy", () => {
  // Stored approval args are JSON that has round-tripped through a database;
  // "true" is not true, and coercing it would let a string decide a thing the
  // user is on the hook for.
  assert.equal(resolveAddMeet({ addMeet: "true" as never }), false);
  assert.equal(
    resolveAddMeet({ addMeet: "true" as never, attendees: ["a@b.com"] }),
    true,
  );
  assert.equal(resolveAddMeet({ addMeet: null as never }), false);
});
