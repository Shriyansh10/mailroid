/**
 * Older summarizeEmail results collapse to a stub that is resent to the model
 * on every later turn. Refs saved before summarizeEmail masked its output still
 * hold raw senders, so the stub masks them itself.
 *
 *   pnpm --filter web test   (from the repo root)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { trimHistoryForModel, type DbChatMessage } from "./history";

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const summaryResult = (sender: string, subject: string): DbChatMessage => ({
  role: "tool",
  content: JSON.stringify({ found: true, summary: "…long digest…" }),
  tool_call_id: "call-1",
  metadata: { toolName: "summarizeEmail", emailRef: { entityId: "m-old", sender, subject } },
});
const recentTool: DbChatMessage = { role: "tool", content: "{}", tool_call_id: "x", metadata: null };

test("an old (pre-fix) email ref is masked in the stub the model sees", () => {
  const messages: DbChatMessage[] = [
    { role: "user", content: "summarize the invoice" },
    summaryResult("Ravi Kumar <ravi.kumar@acme.com>", "Invoice for jane@client.io"),
    { role: "assistant", content: "Here it is." },
    // Two newer tool results push the summary out of the kept-verbatim window.
    recentTool,
    recentTool,
  ];
  const stub = trimHistoryForModel(messages)[1]!.content!;
  assert.match(stub, /digest elided/);
  assert.doesNotMatch(stub, ADDRESS);
  assert.match(stub, /"sender":"Ravi Kumar"/);
  assert.match(stub, /"entityId":"m-old"/);
});

test("an already-masked ref passes through unchanged", () => {
  const messages: DbChatMessage[] = [summaryResult("Ravi Kumar", "Invoice for [EMAIL]"), recentTool, recentTool];
  const stub = trimHistoryForModel(messages)[0]!.content!;
  assert.match(stub, /"sender":"Ravi Kumar"/);
  assert.match(stub, /"subject":"Invoice for \[EMAIL\]"/);
});

// ── Stored searchEmails / summarizeEmail results (pre-fix rows) ─────────

const framed = (tool: string, data: unknown): DbChatMessage => ({
  role: "tool",
  content: `<tool_result tool="${tool}">\n${JSON.stringify(data)}\n</tool_result>`,
  tool_call_id: `call-${tool}`,
  metadata: { toolName: tool },
});

// A phone-shaped id: the reason maskPII is never run over the raw JSON.
const PHONEY_ID = "18000123456789";

const rawSearch = (n = 1) => ({
  emails: Array.from({ length: n }, (_, i) => ({
    entityId: `${PHONEY_ID}${i}`,
    threadId: `t-${PHONEY_ID}${i}`,
    sender: "Ravi Kumar <ravi.kumar@acme.com>",
    subject: "Invoice for jane@client.io",
    date: "2026-09-01T10:00:00.000Z",
    snippet: "Call me on +1 415 555 0134 or write to ravi.kumar@acme.com",
  })),
  primaryTotal: n,
  spamCount: 2,
  hiddenProtected: { count: 1, senders: ["bank@secure-bank.com"] },
});

test("an old raw searchEmails result in the verbatim window comes out masked, ids intact", () => {
  const out = trimHistoryForModel([{ role: "user", content: "find it" }, framed("searchEmails", rawSearch())])[1]!.content!;
  assert.doesNotMatch(out, ADDRESS);
  assert.doesNotMatch(out, /415 555 0134/);
  assert.match(out, /"sender":"Ravi Kumar"/);
  assert.match(out, new RegExp(`"entityId":"${PHONEY_ID}0"`));
  assert.match(out, new RegExp(`"threadId":"t-${PHONEY_ID}0"`));
  assert.match(out, /"date":"2026-09-01T10:00:00.000Z"/);
  assert.match(out, /"primaryTotal":1,"spamCount":2/);
  assert.match(out, /"hiddenProtected":\{"count":1,"senders":\["\[EMAIL\]"\]\}/);
  assert.match(out, /^<tool_result tool="searchEmails">\n\{.*\}\n<\/tool_result>$/s);
});

test("an old raw searchEmails result is masked before it is truncated", () => {
  const messages: DbChatMessage[] = [framed("searchEmails", rawSearch(8)), recentTool, recentTool];
  const out = trimHistoryForModel(messages)[0]!.content!;
  assert.match(out, /…\[truncated\]$/);
  // Not even a fragment of an address survives the cut.
  assert.doesNotMatch(out, /acme|client\.io|ravi\.kum/);
  assert.match(out, new RegExp(`"entityId":"${PHONEY_ID}0"`));
});

test("an old raw summarizeEmail result: sender, subject and candidates masked", () => {
  const raw = {
    found: true,
    entityId: PHONEY_ID,
    threadId: `t-${PHONEY_ID}`,
    sender: "ravi.kumar@acme.com",
    subject: "Re: call +1 415 555 0134",
    summary: "digest",
    candidates: [{ entityId: "c1", sender: "Ravi Shah <rs@b.com>", subject: "Hello rs@b.com" }],
  };
  const out = trimHistoryForModel([framed("summarizeEmail", raw)])[0]!.content!;
  assert.doesNotMatch(out, ADDRESS);
  assert.doesNotMatch(out, /415 555 0134/);
  assert.match(out, /"sender":"\[EMAIL\]"/);
  assert.match(out, /"candidates":\[\{"entityId":"c1","sender":"Ravi Shah"/);
  assert.match(out, new RegExp(`"entityId":"${PHONEY_ID}"`));
  assert.match(out, /"summary":"digest"/);
});

test("an already-masked stored result is byte-identical", () => {
  const masked = trimHistoryForModel([framed("searchEmails", rawSearch(2))])[0]!;
  const again = trimHistoryForModel([masked])[0]!;
  assert.equal(again.content, masked.content);
  assert.equal(trimHistoryForModel([again])[0], again);
});

test("unparseable stored content is left exactly as it was", () => {
  const broken: DbChatMessage = {
    role: "tool",
    content: `<tool_result tool="searchEmails">\n{"emails":[{"sender":"ravi@acme.com"\n</tool_result>`,
    tool_call_id: "b",
    metadata: null,
  };
  assert.equal(trimHistoryForModel([broken])[0]!.content, broken.content);
});

test("other tools' results are untouched", () => {
  const other = framed("getEvents", { events: [{ id: PHONEY_ID, attendees: ["ravi@acme.com"] }] });
  const error: DbChatMessage = {
    role: "tool",
    content: `<tool_error tool="searchEmails">\n{"error":"ravi@acme.com not found"}\n</tool_error>`,
    tool_call_id: "e",
    metadata: null,
  };
  const out = trimHistoryForModel([other, error]);
  assert.equal(out[0], other);
  assert.equal(out[1], error);
});
