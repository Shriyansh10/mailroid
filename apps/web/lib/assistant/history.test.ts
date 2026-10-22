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
