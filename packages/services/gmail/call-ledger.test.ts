/**
 * Tests for the Gmail call ledger's pure parts.
 *
 * WHAT IS ASSERTED HERE AND WHY. Two of these functions decide what a quota
 * total means, and a wrong answer from either is invisible: a mis-derived
 * operation silently books calls under the wrong method, and a guessed quota
 * cost produces a total that looks authoritative and is not. The incident this
 * ledger exists for was prolonged by exactly that class of confident-but-wrong
 * number, so the rules get tests rather than trust.
 *
 * Pure functions only — no logger, no rollup timers, no network. The recording
 * path itself is covered by the rollup's own tests in @repo/logger.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FALLBACK_QUOTA_UNITS,
  GMAIL_TRIGGERS,
  gmailOperationFromUrl,
  normaliseTrigger,
  quotaUnitsFor,
  quotaUnitsForPacing,
} from "./call-ledger.ts";

// ── quota costs ─────────────────────────────────────────────────────

test("quota costs match the verified table", () => {
  // notes/reference/gmail-quota-units.md, verified 2026-08-26 against
  // developers.google.com. These six are the ones the incident arithmetic
  // turns on.
  assert.equal(quotaUnitsFor("history.list"), 2);
  assert.equal(quotaUnitsFor("messages.list"), 5);
  assert.equal(quotaUnitsFor("messages.get"), 20);
  assert.equal(quotaUnitsFor("attachments.get"), 20);
  assert.equal(quotaUnitsFor("threads.get"), 40);
  assert.equal(quotaUnitsFor("watch"), 100);
});

test("an unlisted operation reports no cost rather than a guessed one", () => {
  // `labels.get` USED TO BE ASSERTED HERE as genuinely absent, and that was the
  // right call on the evidence available: inferring 1 from `labels.list` would
  // have been precisely the guess this rule forbids. The page has since been
  // read in full and it IS published, at 1 — so it moved into the table and out
  // of this test. The rule did its job; it stopped a guess that happened to be
  // correct from being encoded before anyone had checked.
  //
  // What remains here is the genuinely unpriced: a function name that no quota
  // table has a row for, and the empty string.
  assert.equal(quotaUnitsFor("syncHistoryForTenant"), undefined);
  assert.equal(quotaUnitsFor(""), undefined);
});

test("the rows added for pacing match the verified table", () => {
  // Read in full on 2026-08-26 to price the limiter. The three worth naming are
  // the counter-intuitive ones: fetching one draft is not cheap, updating one is
  // not free, and tearing a watch down costs half what setting it up does.
  assert.equal(quotaUnitsFor("labels.get"), 1);
  assert.equal(quotaUnitsFor("drafts.list"), 5);
  assert.equal(quotaUnitsFor("drafts.get"), 20);
  assert.equal(quotaUnitsFor("drafts.update"), 15);
  assert.equal(quotaUnitsFor("threads.trash"), 20);
  assert.equal(quotaUnitsFor("threads.untrash"), 10);
  assert.equal(quotaUnitsFor("messages.batchModify"), 50);
  assert.equal(quotaUnitsFor("stop"), 50);
});

test("pacing never sees undefined, and never silently sees zero", () => {
  // The two functions disagree ON PURPOSE. For telemetry an invented cost
  // corrupts the evidence, so `undefined` is the honest answer. For pacing,
  // `undefined` collapsing to 0 would let an unpriced operation run completely
  // unthrottled — the exact bug the limiter exists to fix.
  assert.equal(quotaUnitsFor("syncHistoryForTenant"), undefined);
  assert.equal(quotaUnitsForPacing("syncHistoryForTenant"), FALLBACK_QUOTA_UNITS);

  // A priced operation must give the same answer to both.
  assert.equal(quotaUnitsForPacing("threads.get"), 40);
  assert.equal(quotaUnitsForPacing("threads.get"), quotaUnitsFor("threads.get"));

  // The fallback must be an over-estimate against everything but the 100s,
  // so an unpriced operation is throttled too hard rather than not at all.
  assert.ok(FALLBACK_QUOTA_UNITS >= 40, "fallback must exceed threads.get");
});

test("QUOTA_UNITS does not drift from the reference notes", () => {
  // The table's own comment names notes/reference/gmail-quota-units.md as the
  // source of truth. Nothing enforced that, so the two could silently disagree
  // and the code would still look authoritative. Parse the markdown and check.
  const notes = readFileSync(
    fileURLToPath(new URL("../../../notes/reference/gmail-quota-units.md", import.meta.url)),
    "utf8",
  );

  const published = new Map<string, number>();
  for (const line of notes.split(/\r?\n/)) {
    const row = line.match(/^\|\s*`([a-zA-Z.]+)`\s*\|\s*(\d+)\s*\|/);
    if (row) published.set(row[1]!, Number(row[2]));
  }

  assert.ok(published.size >= 25, `parsed only ${published.size} rows from the notes`);

  for (const [operation, units] of published) {
    const encoded = quotaUnitsFor(operation);
    // An operation may legitimately be in the notes and not yet in the code —
    // what must never happen is the code claiming a DIFFERENT number.
    if (encoded !== undefined) {
      assert.equal(encoded, units, `${operation}: code says ${encoded}, notes say ${units}`);
    }
  }

  // The keys the codebase spells differently from Google still have to agree
  // with the row they alias.
  assert.equal(quotaUnitsFor("attachments.get"), published.get("messages.attachments.get"));
  assert.equal(quotaUnitsFor("users.getProfile"), published.get("getProfile"));
});

// ── operation derivation ────────────────────────────────────────────

test("the operation comes from the URL, which is what actually reached Google", () => {
  assert.equal(
    gmailOperationFromUrl(
      "https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=123",
    ),
    "history.list",
  );
  assert.equal(
    gmailOperationFromUrl("https://gmail.googleapis.com/gmail/v1/users/me/profile"),
    "getProfile",
  );
  assert.equal(
    gmailOperationFromUrl("https://gmail.googleapis.com/gmail/v1/users/me/watch"),
    "watch",
  );
});

test("a collection and a single resource are different operations", () => {
  // They cost 5 and 20 units respectively, so conflating them is a 4x error in
  // the only number that says whether a quota was plausibly exhausted.
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";
  assert.equal(gmailOperationFromUrl(`${base}/messages`), "messages.list");
  assert.equal(gmailOperationFromUrl(`${base}/messages/18f2c`), "messages.get");
  assert.equal(gmailOperationFromUrl(`${base}/threads`), "threads.list");
  assert.equal(gmailOperationFromUrl(`${base}/threads/18f2c`), "threads.get");
});

test("attachment and send paths are recognised, not folded into messages.get", () => {
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";
  assert.equal(
    gmailOperationFromUrl(`${base}/messages/18f2c/attachments/ANGjdJ8x`),
    "attachments.get",
  );
  assert.equal(gmailOperationFromUrl(`${base}/messages/send`), "messages.send");
  assert.equal(
    gmailOperationFromUrl(
      "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
    ),
    "messages.send",
  );
});

test("the query string is never parsed — it can carry credentials", () => {
  // Not a style point: the webhook push token travels in a query string in this
  // codebase, and a logger that reads query parameters is one refactor away
  // from writing one to disk.
  assert.equal(
    gmailOperationFromUrl(
      "https://gmail.googleapis.com/gmail/v1/users/me/history?token=secret&pageToken=abc",
    ),
    "history.list",
  );
});

test("sub-resource actions are not mistaken for a bare get", () => {
  // REGRESSION GUARD, AND NOW A PACING ONE. /threads/{id}/trash previously fell
  // through to the bare-id branch and booked as threads.get — 40 units for a
  // 20-unit call. That was a reporting error while this table only fed logs;
  // once it prices the limiter, it over-throttles the mailbox 2x on every trash
  // and 4x on every untrash.
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";

  assert.equal(gmailOperationFromUrl(`${base}/threads/abc/trash`), "threads.trash");
  assert.equal(gmailOperationFromUrl(`${base}/threads/abc/untrash`), "threads.untrash");
  assert.equal(gmailOperationFromUrl(`${base}/messages/abc/trash`), "messages.trash");
  assert.equal(gmailOperationFromUrl(`${base}/messages/abc/untrash`), "messages.untrash");
  assert.equal(gmailOperationFromUrl(`${base}/messages/batchDelete`), "messages.batchDelete");

  // The bare-id forms must still resolve to the plain get — the fix must not
  // have swallowed the common case.
  assert.equal(gmailOperationFromUrl(`${base}/threads/abc`), "threads.get");
  assert.equal(gmailOperationFromUrl(`${base}/messages/abc`), "messages.get");

  // And each one must be priced, or the pacing fallback quietly takes over.
  for (const op of [
    "threads.trash",
    "threads.untrash",
    "messages.trash",
    "messages.untrash",
    "messages.batchDelete",
  ]) {
    assert.notEqual(quotaUnitsFor(op), undefined, `${op} derived but unpriced`);
  }
});

test("an unrecognised URL yields undefined, which becomes quotaUnknown", () => {
  assert.equal(gmailOperationFromUrl("https://example.com/nothing/like/gmail"), undefined);
  assert.equal(gmailOperationFromUrl(""), undefined);
  assert.equal(
    gmailOperationFromUrl("https://gmail.googleapis.com/gmail/v1/users/me/settings/forwarding"),
    undefined,
  );
});

// ── trigger taxonomy ────────────────────────────────────────────────

test("the taxonomy covers the triggers already in use at call sites", () => {
  // Folding a live trigger into "unknown" would manufacture a finding, since an
  // unknown in a summary is supposed to mean "a call site reached Gmail without
  // saying why".
  for (const inUse of ["ui", "sync", "webhook", "resume-cron", "watch-cron", "calendar", "oauth-callback"]) {
    assert.equal(normaliseTrigger(inUse), inUse, `${inUse} should be a listed trigger`);
  }
});

test("watch-bootstrap and watch-cron stay distinct", () => {
  // H-B is specifically about calls made because the process restarted. A watch
  // renewed on boot and one renewed on a schedule cost the same 100 units and
  // mean completely different things.
  assert.notEqual(normaliseTrigger("watch-bootstrap"), normaliseTrigger("watch-cron"));
});

test("an unlisted trigger folds into unknown rather than opening a new bucket", () => {
  // The key space must stay bounded: free-form strings at call sites are how a
  // diagnostic map grows without limit under exactly the storm it is watching.
  assert.equal(normaliseTrigger("Webhook"), "unknown");
  assert.equal(normaliseTrigger("some-new-thing"), "unknown");
  assert.equal(normaliseTrigger(undefined), "unknown");
  assert.equal(normaliseTrigger(""), "unknown");
});

test("the taxonomy is closed and contains no duplicates", () => {
  assert.equal(new Set(GMAIL_TRIGGERS).size, GMAIL_TRIGGERS.length);
  assert.ok(GMAIL_TRIGGERS.includes("unknown"), "unknown must always be available");
});
