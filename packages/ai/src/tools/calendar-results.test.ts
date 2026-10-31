/**
 * Calendar data as the model may see it: attendees are names, never
 * addresses, and invite free text is masked. Ids, times and statuses intact.
 *
 * Run: pnpm --filter @repo/ai test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  allAttendeeAddresses,
  attendeesForModel,
  eventForModel,
  mergeAttendeeNames,
} from "./calendar-results.ts";
import { metricsPersonForModel, matchPeopleByName } from "./metrics-results.ts";
import { toolErrorForModel } from "./model-masking.ts";

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /415[\s-]?555[\s-]?0134/;

test("attendees: a known name, the user as You, and [EMAIL] for nobody known", () => {
  const out = attendeesForModel(
    ["Ravi@Acme.com", "me@mine.com", "stranger@x.io"],
    { "ravi@acme.com": "Ravi Kumar" },
    "ME@mine.com",
  );
  assert.deepEqual(out, ["Ravi Kumar", "You", "[EMAIL]"]);
});

test("attendees: a 'name' that is itself an address or a phone never gets through", () => {
  const out = attendeesForModel(
    ["a@b.com", "c@d.com"],
    { "a@b.com": "a@b.com", "c@d.com": "Call +1 415 555 0134" },
  );
  assert.equal(out[0], "[EMAIL]");
  assert.doesNotMatch(JSON.stringify(out), ADDRESS);
  assert.doesNotMatch(JSON.stringify(out), PHONE);
});

test("an event: no address or phone anywhere, ids and times intact", () => {
  const ev = eventForModel(
    {
      id: "evt_18000123456789",
      title: "Sync with ravi@acme.com",
      start: "2026-10-22T10:30:00+05:30",
      end: "2026-10-22T11:00:00+05:30",
      allDay: false,
      description: "Dial in: +1 415 555 0134, host jane@client.io",
      location: "Room 4, or call +1 415 555 0134",
      attendees: ["ravi@acme.com", "jane@client.io"],
      status: "upcoming",
    },
    { "ravi@acme.com": "Ravi Kumar" },
  );
  const json = JSON.stringify(ev);
  assert.doesNotMatch(json, ADDRESS);
  assert.doesNotMatch(json, PHONE);
  assert.equal(ev.id, "evt_18000123456789");
  assert.equal(ev.start, "2026-10-22T10:30:00+05:30");
  assert.equal(ev.end, "2026-10-22T11:00:00+05:30");
  assert.equal(ev.status, "upcoming");
  assert.deepEqual(ev.attendees, ["Ravi Kumar", "[EMAIL]"]);
});

test("names: Google's name wins over one known from mail", () => {
  const names = mergeAttendeeNames({ "r@a.com": "Ravi K (Google)" }, undefined, { "r@a.com": "Ravi", "s@b.com": "Sam" });
  assert.equal(names["r@a.com"], "Ravi K (Google)");
  assert.equal(names["s@b.com"], "Sam");
  assert.deepEqual(allAttendeeAddresses([["R@a.com"], undefined, ["r@a.com", "s@b.com"]]), ["r@a.com", "s@b.com"]);
});

test("metrics people: a ref and a name, never the address", () => {
  assert.deepEqual(metricsPersonForModel({ name: "Amit Shah" }, "ct_1"), { ref: "ct_1", name: "Amit Shah" });
  assert.deepEqual(metricsPersonForModel({ name: null }, "ct_2"), { ref: "ct_2", name: "[EMAIL]" });
  assert.deepEqual(metricsPersonForModel({ name: "amit@acme.com" }, "ct_3"), { ref: "ct_3", name: "[EMAIL]" });
});

test("metrics name match: by name only, never by address", () => {
  const people = [
    { email: "amit@acme.com", name: "Amit Shah" },
    { email: "amita@acme.com", name: "Amita Rao" },
    { email: "zed@acme.com", name: null },
  ];
  assert.equal(matchPeopleByName(people, "amit").length, 2);
  assert.equal(matchPeopleByName(people, "Rao").length, 1);
  assert.equal(matchPeopleByName(people, "zed").length, 0);
  assert.equal(matchPeopleByName(people, "  ").length, 0);
});

test("tool errors: an upstream message loses addresses and phones, keeps the rest", () => {
  const out = toolErrorForModel("Invalid attendee email: jane@client.io (call +1 415 555 0134)", "failed");
  assert.doesNotMatch(out, ADDRESS);
  assert.doesNotMatch(out, PHONE);
  assert.match(out, /^Invalid attendee email: \[EMAIL\]/);
  assert.equal(toolErrorForModel(undefined, "Tool execution failed"), "Tool execution failed");
});
