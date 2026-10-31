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

test("tools that return no mailbox text are untouched", () => {
  const slots = framed("findMeetingSlots", {
    intent: "LUNCH",
    candidates: [{ start: "2026-10-23T13:00:00", end: "2026-10-23T14:00:00", score: 0.9, reasons: [] }],
    conflicts: ["+1 415 555 0134"],
  });
  assert.equal(trimHistoryForModel([slots])[0], slots);
});

test("an old getEvents result: attendees, title, description and location masked; ids and times intact", () => {
  const old = framed("getEvents", {
    events: [{
      id: PHONEY_ID,
      title: "Call with ravi@acme.com",
      start: "2026-10-22T10:30:00+05:30",
      end: "2026-10-22T11:00:00+05:30",
      description: "Dial +1 415 555 0134",
      location: "jane@client.io's office",
      attendees: ["ravi@acme.com", "Ravi Kumar <ravi@acme.com>"],
      status: "upcoming",
    }],
  });
  const out = trimHistoryForModel([old])[0]!.content!;
  assert.doesNotMatch(out, ADDRESS);
  assert.doesNotMatch(out, /415 555 0134/);
  assert.match(out, /"attendees":\["\[EMAIL\]","Ravi Kumar"\]/);
  assert.match(out, new RegExp(`"id":"${PHONEY_ID}"`));
  assert.match(out, /"start":"2026-10-22T10:30:00\+05:30","end":"2026-10-22T11:00:00\+05:30"/);
});

test("a names-only getEvents / getThreadMeetings result replays byte-identical", () => {
  const events = framed("getEvents", {
    events: [{ id: "e1", title: "Lunch", start: "2026-10-22T13:00:00Z", end: "2026-10-22T14:00:00Z", attendees: ["You", "Ravi Kumar", "[EMAIL]"] }],
  });
  const meetings = framed("getThreadMeetings", {
    meetings: [{ selectionId: "sel_1", title: "Sync", start: "s", end: "e", attendees: ["Ravi Kumar"], past: false }],
  });
  const out = trimHistoryForModel([events, meetings]);
  assert.equal(out[0], events);
  assert.equal(out[1], meetings);
});

test("an old summarizeEmail result's meeting attendees are masked", () => {
  const out = trimHistoryForModel([
    framed("summarizeEmail", { found: true, entityId: "m1", meetings: [{ title: "Sync", start: "s", end: "e", attendees: ["ravi@acme.com"] }] }),
  ])[0]!.content!;
  assert.doesNotMatch(out, ADDRESS);
  assert.match(out, /"attendees":\["\[EMAIL\]"\]/);
});

test("an old getCommunicationMetrics result loses each colleague's address", () => {
  const out = trimHistoryForModel([
    framed("getCommunicationMetrics", {
      found: true,
      people: [{ email: "amit@acme.com", name: "Amit Shah", received: 12 }, { email: "zed@acme.com", received: 3 }],
    }),
  ])[0]!.content!;
  assert.doesNotMatch(out, ADDRESS);
  assert.match(out, /\{"name":"Amit Shah","received":12\}/);
  assert.match(out, /\{"received":3,"name":"\[EMAIL\]"\}/);
});

test("an old executive brief is masked", () => {
  const out = trimHistoryForModel([
    framed("generateExecutiveBrief", { briefing: "- **From ravi@acme.com**: *Q3* — call +1 415 555 0134 on 2026-10-22" }),
  ])[0]!.content!;
  assert.doesNotMatch(out, ADDRESS);
  assert.doesNotMatch(out, /415 555 0134/);
  assert.match(out, /2026-10-22/);
});

test("a stored tool error from any tool is masked", () => {
  const error: DbChatMessage = {
    role: "tool",
    content: `<tool_error tool="createEvent">\n{"error":"Invalid attendee email: ravi@acme.com"}\n</tool_error>`,
    tool_call_id: "e",
    metadata: null,
  };
  const out = trimHistoryForModel([error])[0]!.content!;
  assert.equal(out, `<tool_error tool="createEvent">\n{"error":"Invalid attendee email: [EMAIL]"}\n</tool_error>`);
});
