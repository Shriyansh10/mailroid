/**
 * The system prompt tells Dobbie that every sender it has seen was replaced
 * with "[EMAIL]". The EMAIL CONTEXT block is read fresh from the database, so
 * it must mask on the way in for that sentence to stay true.
 *
 *   pnpm --filter web test   (from the repo root)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "./system-prompt";

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// The block itself, not the instructions earlier in the prompt that mention
// it by name (and contain an example address the user might type).
const contextBlock = (prompt: string) => {
  const start = prompt.indexOf("EMAIL CONTEXT — the email currently under discussion");
  assert.ok(start >= 0, "context block rendered");
  const rest = prompt.slice(start);
  return rest.slice(0, rest.indexOf("When the user says"));
};

test("EMAIL CONTEXT carries no raw sender or subject address", () => {
  const prompt = buildSystemPrompt({
    userTimeZone: "Asia/Kolkata",
    emailContext: {
      entityId: "18f2a9c4e1b7d3a0",
      threadId: "18f2a9c4e1b7d3a0",
      subject: "Invoice for jane@client.io",
      sender: "Ravi Kumar <ravi.kumar@acme.com>",
      receivedAt: "2026-10-01T10:00:00.000Z",
    },
  });
  const block = contextBlock(prompt);
  assert.doesNotMatch(block, ADDRESS);
  assert.match(block, /from: Ravi Kumar/);
  assert.match(block, /subject: Invoice for \[EMAIL\]/);
  // Ids and dates are what follow-up calls need, and stay intact.
  assert.match(block, /entityId: 18f2a9c4e1b7d3a0/);
  assert.match(block, /received: 2026-10-01T10:00:00\.000Z/);
});

test("a bare-address sender becomes [EMAIL]", () => {
  const block = contextBlock(
    buildSystemPrompt({
      userTimeZone: "UTC",
      emailContext: { entityId: "m1", sender: "billing@acme.com" },
    }),
  );
  assert.match(block, /from: \[EMAIL\]/);
});
