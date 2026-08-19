/**
 * Tests for the literal-address path through resolveRecipient.
 *
 * This exists because of a real failure. The assistant used to be told it had
 * *never* seen a real email address — true of email content, which is masked,
 * but false of the user's own message to it, which is not. So a user typing
 * "schedule a call with sam@acme.com" had the precise address thrown away and
 * got a disambiguation prompt listing four people with identical names.
 *
 * The prompt now tells the model to pass a user-typed address straight
 * through. That reopens a second hazard these tests pin down: parseAddressList
 * reads everything before the address as a display name, and persistAndProject
 * OVERWRITES display_name on conflict. Passing the surrounding phrase would
 * therefore rename a real contact to "schedule a call with" — permanently, and
 * for every future disambiguation.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseAddressList, explicitDisplayName } from "./contacts.ts";

// ── parseAddressList: what the fast path keys off ────────────────────

test("a bare address is a single parsed address", () => {
  const parsed = parseAddressList("sam@acme.com");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.email, "sam@acme.com");
});

test("addresses are normalised to lower case, so handles are stable", () => {
  assert.equal(parseAddressList("Sam@Acme.COM")[0]?.email, "sam@acme.com");
});

test("an address embedded in prose still resolves — the phrase is not fatal", () => {
  // The model is expected to pass the address alone, but must not break the
  // whole flow when it includes the sentence around it.
  const parsed = parseAddressList("schedule a call with sam@acme.com");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.email, "sam@acme.com");
});

// ── explicitDisplayName: the guard that protects stored contacts ─────

test("a bare address keeps no display name — one is derived from the address", () => {
  const parsed = parseAddressList("sam@acme.com");
  assert.equal(explicitDisplayName("sam@acme.com", parsed[0]?.displayName), undefined);
});

test("angle-bracket form keeps the real name", () => {
  const query = "Alex Mehta <alex@x.com>";
  const parsed = parseAddressList(query);
  assert.equal(explicitDisplayName(query, parsed[0]?.displayName), "Alex Mehta");
});

test("prose around an address is NOT stored as the contact's name", () => {
  // The regression this file exists for: without the guard the contact would
  // be renamed "schedule a call with" on every conflicting upsert.
  const query = "schedule a call with sam@acme.com";
  const parsed = parseAddressList(query);
  assert.equal(parsed[0]?.displayName, "schedule a call with");
  assert.equal(explicitDisplayName(query, parsed[0]?.displayName), undefined);
});

test("surrounding whitespace does not defeat the angle-bracket form", () => {
  const query = "  Alex Mehta <alex@x.com>  ";
  const parsed = parseAddressList(query);
  assert.equal(explicitDisplayName(query, parsed[0]?.displayName), "Alex Mehta");
});

test("prose that also contains angle brackets is still rejected", () => {
  // `<` and `>` appearing anywhere must not be enough to pass the guard.
  const query = "tell <b>sam@acme.com</b> about it";
  assert.equal(explicitDisplayName(query, "tell <b>"), undefined);
});
