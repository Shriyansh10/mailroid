/**
 * Tests for mentionsAttachment — fires on explicit "here is a file" phrasing,
 * and stays quiet on ordinary uses of the same words.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { mentionsAttachment } from "./attachment-reminder.ts";

const POSITIVES = [
  "Please find the invoice attached!",
  "Please find attached the report.",
  "please find the Q3 deck attached",
  "See attached:",
  "see attached.",
  "Find attached the contract.",
  "Attached is the signed NDA.",
  "Attached are both versions.",
  "The invoice is attached.",
  "Both files are attached",
  "I've attached the slides.",
  "I’ve attached the slides.", // curly apostrophe
  "I have attached the draft",
  "We've attached the quote",
  "I'm attaching the photos now",
  "I am attaching the form",
  "Details are in the attachment.",
  "Please see the attachment",
  "PFA.",
  "pfa, thanks",
  "Hi, PFA the report",
  "Enclosed is the agreement.",
  "Please find enclosed the receipt",
  "I have enclosed the receipt",
];

const NEGATIVES = [
  "",
  "   ",
  "I'm attached to this plan.",
  "Are you still attached to the old design?",
  "This was attached to the email thread below?",
  "attached to the email thread below?",
  "My attachment style is anxious.",
  "We walked through an enclosed garden.",
  "PFAS levels in the water are rising.",
  "Thanks, see you tomorrow.",
  "Can you send me the attachment from yesterday?",
];

test("explicit attachment phrasings are recognised", () => {
  for (const body of POSITIVES) {
    assert.equal(mentionsAttachment(body), true, `should fire: ${JSON.stringify(body)}`);
  }
});

test("ordinary uses of the same words do not fire", () => {
  for (const body of NEGATIVES) {
    assert.equal(mentionsAttachment(body), false, `should NOT fire: ${JSON.stringify(body)}`);
  }
});
