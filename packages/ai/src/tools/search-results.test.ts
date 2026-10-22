/**
 * Regression tests: searchEmails must not hand the model raw email addresses
 * or phone numbers — the system prompt tells it every sender was already
 * replaced with "[EMAIL]", and the agent loop's own output pass does not mask
 * addresses. Ids, dates and counts must pass through untouched so follow-up
 * calls still work.
 *
 * Run: pnpm --filter @repo/ai test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { shapeSearchEmailsForModel } from "./search-results.ts";
import { senderForModel } from "./model-masking.ts";

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const row = (over: Record<string, unknown> = {}) => ({
  entityId: "18f2a9c4e1b7d3a0",
  threadId: "18f2a9c4e1b7d3a0",
  sender: "Ravi Kumar <ravi.kumar@acme.com>",
  subject: "Invoice for jane@client.io",
  date: "2026-10-01T10:00:00.000Z",
  snippet: "Call me on +1 415 555 0134 or write to billing@acme.com about the invoice.",
  score: 0.82,
  ...over,
});

const shape = (rows: ReturnType<typeof row>[], extra: Record<string, unknown> = {}) =>
  shapeSearchEmailsForModel({ threads: rows, total: rows.length, spamCount: 1, ...extra }, 40);

test("no raw email address anywhere in what the model receives", () => {
  const out = shape([row(), row({ sender: "billing@acme.com" })], {
    hiddenProtected: { count: 2, senders: ["boss@corp.com", "Bank of Example"] },
  });
  assert.doesNotMatch(JSON.stringify(out), ADDRESS);
});

test("no raw phone number in the snippet", () => {
  const out = shape([row()]);
  assert.doesNotMatch(out.emails[0]!.snippet, /415\s*555\s*0134/);
  assert.match(out.emails[0]!.snippet, /\[PHONE\]/);
});

test("senders become display names, or [EMAIL] for a bare address", () => {
  const out = shape([row(), row({ sender: "billing@acme.com" }), row({ sender: '"Acme Billing" <b@acme.com>' })]);
  assert.deepEqual(out.emails.map((e) => e.sender), ["Ravi Kumar", "[EMAIL]", "Acme Billing"]);
});

test("ids, dates, scores and counts pass through untouched", () => {
  const out = shape([row()]);
  const [e] = out.emails;
  assert.equal(e!.entityId, "18f2a9c4e1b7d3a0");
  assert.equal(e!.threadId, "18f2a9c4e1b7d3a0");
  assert.equal(e!.date, "2026-10-01T10:00:00.000Z");
  assert.equal(e!.score, 0.82);
  assert.equal(out.primaryTotal, 1);
  assert.equal(out.spamCount, 1);
});

test("the display cap still applies", () => {
  const rows = Array.from({ length: 50 }, (_, i) => row({ entityId: `m${i}` }));
  assert.equal(shapeSearchEmailsForModel({ threads: rows, total: 50 }, 40).emails.length, 40);
});

test("protected senders are masked but still counted", () => {
  const out = shape([], { hiddenProtected: { count: 3, senders: ["boss@corp.com", "HR Team <hr@corp.com>"] } });
  assert.deepEqual(out.hiddenProtected, { count: 3, senders: ["[EMAIL]", "HR Team"] });
});

test("a display name that is itself an address is masked", () => {
  assert.equal(senderForModel('"ravi@acme.com" <ravi@acme.com>'), "[EMAIL]");
});
