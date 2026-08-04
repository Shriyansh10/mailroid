/**
 * Zone-conversion tests for the slot engine's boundary helpers.
 *
 * These exist because of a real, outward-facing bug: `findMeetingSlots`
 * emitted candidate times with `.toISOString()`, so a 09:00 IST slot crossed
 * the model boundary as "2026-08-05T03:30:00.000Z". The model read those digits
 * as local time, offered the user "3:30 AM", and — because the value was then
 * echoed straight into createEvent, which treats an offset-less string as
 * local — actually booked the meeting at 3:30 AM and emailed the attendees.
 *
 * Every case below is either that bug, or an adjacent one that would produce
 * the same silent hour shift. The arithmetic is invisible in review and the
 * symptom only shows up on someone's real calendar, which is exactly what
 * makes it worth pinning.
 *
 * Run: pnpm --filter @repo/shared test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  formatZonedWallClock,
  parseZonedWallClock,
  zonedWallClockToUtc,
  dateKeyInZone,
  minutesOfDayInZone,
} from "./slots.ts";

const IST = "Asia/Calcutta"; // UTC+5:30, no DST — the half-hour offset from the bug report
const NY = "America/New_York"; // DST, whole-hour offsets
const UTC = "UTC";

// ── The reported bug ──────────────────────────────────────────────────

test("a 09:00 IST slot is described as 09:00, not as its UTC digits", () => {
  const nineAmIst = zonedWallClockToUtc("2026-08-05", "09:00", IST);
  assert.ok(nineAmIst);

  // The instant is, and always was, correct.
  assert.equal(nineAmIst.toISOString(), "2026-08-05T03:30:00.000Z");

  // What changed: this is what now crosses the boundary to the model. The old
  // behaviour handed over "…T03:30:00.000Z", which read as 3:30 AM.
  assert.equal(formatZonedWallClock(nineAmIst, IST), "2026-08-05T09:00:00");
});

test("a slot the model echoes back resolves to the instant it was offered at", () => {
  // The full round trip that used to lose 5h30m: engine → model → createEvent.
  const offered = zonedWallClockToUtc("2026-08-05", "09:00", IST)!;
  const asShownToModel = formatZonedWallClock(offered, IST);
  const asBooked = parseZonedWallClock(asShownToModel, IST);

  assert.ok(asBooked);
  assert.equal(asBooked.getTime(), offered.getTime());
});

test("offset-less input is read in the user's zone, never the server's", () => {
  // The symmetric bug on the input side: bare `new Date("2026-08-05T09:00:00")`
  // resolves against the *server's* zone, so on a UTC host every user-supplied
  // time silently slid by the user's whole offset.
  const parsed = parseZonedWallClock("2026-08-05T09:00:00", IST);
  assert.ok(parsed);
  assert.equal(parsed.toISOString(), "2026-08-05T03:30:00.000Z");

  // Same digits, different zone, genuinely different instant.
  const inUtc = parseZonedWallClock("2026-08-05T09:00:00", UTC);
  assert.ok(inUtc);
  assert.equal(inUtc.toISOString(), "2026-08-05T09:00:00.000Z");
  assert.notEqual(parsed.getTime(), inUtc.getTime());
});

// ── Back-compat: records written before the format changed ────────────

test("strings that already pin an instant are taken as absolute", () => {
  // Slot proposals stored before this change hold `…Z` values, and refine
  // replays them. Re-interpreting those as wall-clock would shift them; this
  // branch is what makes the change need no backfill.
  const legacy = parseZonedWallClock("2026-08-05T03:30:00.000Z", IST);
  assert.ok(legacy);
  assert.equal(legacy.toISOString(), "2026-08-05T03:30:00.000Z");

  const withOffset = parseZonedWallClock("2026-08-05T09:00:00+05:30", IST);
  assert.ok(withOffset);
  assert.equal(withOffset.toISOString(), "2026-08-05T03:30:00.000Z");

  // All three spellings of the same moment agree.
  assert.equal(legacy.getTime(), withOffset.getTime());
  assert.equal(legacy.getTime(), parseZonedWallClock("2026-08-05T09:00:00", IST)!.getTime());
});

test("seconds are optional and fractional seconds are tolerated", () => {
  const a = parseZonedWallClock("2026-08-05T09:00", IST);
  const b = parseZonedWallClock("2026-08-05T09:00:00", IST);
  const c = parseZonedWallClock("2026-08-05T09:00:00.000", IST);
  assert.ok(a && b && c);
  assert.equal(a.getTime(), b.getTime());
  assert.equal(b.getTime(), c.getTime());
});

// ── DST ───────────────────────────────────────────────────────────────

test("round-trips across both DST transitions", () => {
  // Spring forward 2026-03-08 (02:00 → 03:00), fall back 2026-11-01
  // (02:00 → 01:00). A single-pass offset probe gets these wrong, which is why
  // parseZonedWallClock resolves the offset twice.
  for (const wallClock of [
    "2026-03-07T12:00:00", // day before spring forward
    "2026-03-08T00:30:00", // before the gap
    "2026-03-08T03:30:00", // after the gap
    "2026-03-09T12:00:00", // day after
    "2026-10-31T12:00:00", // day before fall back
    "2026-11-01T00:30:00", // before the repeated hour
    "2026-11-01T03:00:00", // after the repeated hour
    "2026-11-02T12:00:00", // day after
  ]) {
    const instant = parseZonedWallClock(wallClock, NY);
    assert.ok(instant, `failed to parse ${wallClock}`);
    assert.equal(
      formatZonedWallClock(instant, NY),
      wallClock,
      `round trip changed ${wallClock}`,
    );
  }
});

test("the same wall clock is a different instant either side of a DST change", () => {
  const beforeDst = parseZonedWallClock("2026-03-07T12:00:00", NY)!;
  const afterDst = parseZonedWallClock("2026-03-09T12:00:00", NY)!;

  // Noon to noon across the transition is 47 hours, not 48 — if this reads 48
  // the offset is being taken from a single probe.
  const hours = (afterDst.getTime() - beforeDst.getTime()) / 3_600_000;
  assert.equal(hours, 47);
});

test("working hours land at the right instant either side of a DST change", () => {
  // Same statement ("I work from 09:00"), two different UTC instants. This is
  // the whole reason the engine is zone-aware rather than offset-aware.
  assert.equal(
    zonedWallClockToUtc("2026-03-07", "09:00", NY)!.toISOString(),
    "2026-03-07T14:00:00.000Z", // EST, UTC-5
  );
  assert.equal(
    zonedWallClockToUtc("2026-03-09", "09:00", NY)!.toISOString(),
    "2026-03-09T13:00:00.000Z", // EDT, UTC-4
  );
});

// ── Zone-crossing day boundaries ──────────────────────────────────────

test("late-evening IST is still the same local day, though a later UTC one", () => {
  // The off-by-one-day trap: 23:30 IST is 18:00 UTC the same day, but 01:00
  // IST is the *previous* day in UTC. Anything bucketing by UTC day would put
  // "tomorrow evening" on the wrong date.
  const lateIst = parseZonedWallClock("2026-08-05T23:30:00", IST)!;
  assert.equal(lateIst.toISOString(), "2026-08-05T18:00:00.000Z");
  assert.equal(dateKeyInZone(lateIst, IST), "2026-08-05");

  const earlyIst = parseZonedWallClock("2026-08-05T01:00:00", IST)!;
  assert.equal(earlyIst.toISOString(), "2026-08-04T19:30:00.000Z");
  assert.equal(dateKeyInZone(earlyIst, IST), "2026-08-05"); // still the 5th locally
  assert.equal(dateKeyInZone(earlyIst, UTC), "2026-08-04"); // but the 4th in UTC
});

test("minutesOfDayInZone reads the local clock, not the UTC one", () => {
  const nineAmIst = zonedWallClockToUtc("2026-08-05", "09:00", IST)!;
  assert.equal(minutesOfDayInZone(nineAmIst, IST), 9 * 60);
  assert.equal(minutesOfDayInZone(nineAmIst, UTC), 3 * 60 + 30);
});

// ── Malformed input ───────────────────────────────────────────────────

test("unparseable values are null rather than Invalid Date", () => {
  // Callers branch on null. A returned Invalid Date would propagate as NaN
  // arithmetic and surface as a nonsense time rather than a caught failure.
  for (const bad of ["", "   ", "not a date", "2026-13-45T99:99:99", "tomorrow"]) {
    assert.equal(parseZonedWallClock(bad, IST), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("zonedWallClockToUtc keeps its stricter two-part validation", () => {
  // It takes date and time separately and its callers pass a working-hours
  // "HH:mm", so a value carrying seconds is a bug at the call site rather than
  // input to be tolerated.
  assert.equal(zonedWallClockToUtc("2026-08-05", "09:00:00", IST), null);
  assert.equal(zonedWallClockToUtc("2026-8-5", "09:00", IST), null);
  assert.equal(zonedWallClockToUtc("2026-08-05", "9:00", IST), null);
  assert.ok(zonedWallClockToUtc("2026-08-05", "09:00", IST));
});

test("24:00 means end of day, not an invalid hour", () => {
  // buildDailyWindows accepts a working-hours end of "24:00"; it must roll
  // over to the next midnight rather than parse-fail and silently drop the day.
  const endOfDay = zonedWallClockToUtc("2026-08-05", "24:00", IST);
  assert.ok(endOfDay);
  assert.equal(formatZonedWallClock(endOfDay, IST), "2026-08-06T00:00:00");
});
