/**
 * Tests for RFC822 Message-ID normalisation.
 *
 * This function is the join key between two different people's mailboxes, and
 * they normalise independently — different users, different sync runs. Any
 * asymmetry between two call sites shows up as "the guest just can't see the
 * meeting", with no error raised anywhere and nothing to grep for. So the
 * rules are pinned rather than left to read like obvious string handling.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeMessageId, hashMessageIdForCalendar } from "./message-id.ts";

test("angle brackets are stripped", () => {
  assert.equal(normalizeMessageId("<abc123@mail.gmail.com>"), "abc123@mail.gmail.com");
});

test("a bare id is accepted unchanged", () => {
  // Not every MTA emits the brackets, and the backfill reads the same header
  // through a different code path — both must land on the same value.
  assert.equal(normalizeMessageId("abc123@mail.gmail.com"), "abc123@mail.gmail.com");
});

test("bracketed and bare spellings normalise identically", () => {
  // The actual requirement: the organiser and the guest must agree, whatever
  // shape their respective copies of the header arrived in.
  assert.equal(
    normalizeMessageId("<abc123@mail.gmail.com>"),
    normalizeMessageId("abc123@mail.gmail.com"),
  );
});

test("surrounding and folded whitespace is removed", () => {
  // Long headers fold across lines; the continuation arrives as leading
  // whitespace and would otherwise become part of the id.
  assert.equal(normalizeMessageId("  <abc@x.com>  "), "abc@x.com");
  assert.equal(normalizeMessageId("<abc@x.com>\r\n "), "abc@x.com");
  assert.equal(normalizeMessageId("<abc\r\n @x.com>"), "abc @x.com");
});

test("case is preserved, never folded", () => {
  // RFC 5322 makes the local part case-sensitive, so lowercasing would be a
  // guess about someone else's identifier. Gmail's are lowercase already;
  // other MTAs are not.
  assert.equal(normalizeMessageId("<AbC123@Example.COM>"), "AbC123@Example.COM");
  assert.notEqual(
    normalizeMessageId("<AbC@x.com>"),
    normalizeMessageId("<abc@x.com>"),
  );
});

test("only the first id is taken when a header carries several", () => {
  // Some senders concatenate References-style values into Message-ID. The
  // first is the message's own; matching on the rest would link the wrong
  // conversation.
  assert.equal(normalizeMessageId("<first@x.com> <second@x.com>"), "first@x.com");
});

test("empty and missing values are null", () => {
  // Callers branch on null; an empty string would be stored as the backfill's
  // "checked, nothing here" sentinel and wrongly stop future attempts.
  for (const empty of [null, undefined, "", "   ", "<>"]) {
    assert.equal(normalizeMessageId(empty), null, `expected null for ${JSON.stringify(empty)}`);
  }
});

test("an over-long value is rejected rather than truncated", () => {
  // Google caps an extendedProperties value at 1024. A truncated id would
  // never match while looking perfectly healthy in the database — the exact
  // silent failure this feature must not have.
  const tooLong = `${"x".repeat(1030)}@example.com`;
  assert.equal(normalizeMessageId(`<${tooLong}>`), null);

  // A realistic id is nowhere near the limit and must survive.
  const realistic = "CAJ7Xr_abcdefghijklmnop+1234567890@mail.gmail.com";
  assert.equal(normalizeMessageId(`<${realistic}>`), realistic);
});

test("normalisation is idempotent", () => {
  // Re-running the backfill over an already-populated row must not change it.
  const once = normalizeMessageId("<abc@x.com>")!;
  assert.equal(normalizeMessageId(once), once);
});

/**
 * `hashMessageIdForCalendar` — found via `pnpm admin calendar:probe-shared-props`:
 * Google's `sharedExtendedProperty` filter fails to match a real Gmail
 * Message-ID once it contains `+`/`=`, even though the raw value writes and
 * reads back correctly everywhere else — a lookup that silently finds nothing
 * for a thread that genuinely has a meeting, with no error to grep for. The
 * fix is to never put the raw id in the filtered property at all.
 */

test("output is a fixed-alphabet hex string, regardless of input shape", () => {
  // The whole point: nothing that can trip a query-string parser survives
  // into the value Google actually filters on.
  const realistic = "CAJFu5Lv+k83NOx=ZYjsjY=L-0Unqxa0am7c9+DySjxiWrtGj7g@mail.gmail.com";
  const hash = hashMessageIdForCalendar(realistic);
  assert.match(hash, /^[0-9a-f]{32}$/);
});

test("is deterministic — same input, same output, every time", () => {
  const id = "abc123@mail.gmail.com";
  assert.equal(hashMessageIdForCalendar(id), hashMessageIdForCalendar(id));
});

test("different ids hash differently", () => {
  const a = hashMessageIdForCalendar("first@mail.gmail.com");
  const b = hashMessageIdForCalendar("second@mail.gmail.com");
  assert.notEqual(a, b);
});

test("a single changed character changes the hash", () => {
  // Guards against an implementation that accidentally truncates or
  // normalises its input before hashing, which would make two DIFFERENT
  // Message-IDs collide.
  const a = hashMessageIdForCalendar("CAJFu5Lv+k83NOx=ZYjsjY=abc@mail.gmail.com");
  const b = hashMessageIdForCalendar("CAJFu5Lv+k83NOx=ZYjsjY=abd@mail.gmail.com");
  assert.notEqual(a, b);
});

test("the exact id that exposed the bug hashes cleanly", () => {
  // The literal value from the failed production test — pinned so a future
  // change to the hashing scheme can't silently reintroduce a value shape
  // that breaks Google's filter again.
  const fromProduction = "CAJFu5Lv+k83NOx=ZYjsjY=L-0Unqxa0am7c9+DySjxiWrtGj7g@mail.gmail.com";
  const hash = hashMessageIdForCalendar(fromProduction);
  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.ok(!hash.includes("+"));
  assert.ok(!hash.includes("="));
});
