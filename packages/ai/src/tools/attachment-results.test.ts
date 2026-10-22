/**
 * Tests for what the model is allowed to see about attachments: addresses and
 * phone numbers masked out of filenames and senders (the agent loop's own pass
 * does not mask them), bidi controls stripped, unknown kept distinct from
 * none, and sender matches counted as people.
 *
 * Run: pnpm --filter @repo/ai test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  attachmentsForModel,
  distinctSenders,
  maskForModel,
  parseFromHeader,
  shapeFindAttachmentsResult,
} from "./attachment-results.ts";

test("addresses in filenames never reach the model", () => {
  const masked = maskForModel("invoice-for-jane.doe@acme.com.pdf");
  assert.doesNotMatch(masked, /jane\.doe@acme\.com/);
  assert.match(masked, /\[EMAIL\]/);
});

test("bidi controls are stripped from filenames", () => {
  assert.equal(maskForModel("report‮fdp.exe"), "reportfdp.exe");
});

test("a summary's attachments: unknown stays null, none stays []", () => {
  assert.equal(attachmentsForModel(null), null);
  assert.deepEqual(attachmentsForModel([]), []);
  const [one] = attachmentsForModel([{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 9 }])!;
  assert.deepEqual(one, { filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 9 });
});

test("From headers parse into name and address", () => {
  assert.deepEqual(parseFromHeader('"Ravi Kumar" <Ravi@Acme.com>'), { name: "Ravi Kumar", address: "ravi@acme.com" });
  assert.deepEqual(parseFromHeader("ravi@acme.com"), { name: "", address: "ravi@acme.com" });
  assert.deepEqual(parseFromHeader("Billing Team"), { name: "Billing Team", address: "" });
});

test("one person under two header spellings is one sender; two Ravis are two", () => {
  assert.equal(distinctSenders(["Ravi Kumar <r@a.com>", "r@a.com"]).length, 1);
  const two = distinctSenders(["Ravi Kumar <r@a.com>", "Ravi Shah <rs@b.com>"]);
  assert.deepEqual(two.map((p) => p.displayName), ["Ravi Kumar", "Ravi Shah"]);
});

test("a sender with no display name is shown masked, never as a raw address", () => {
  const [only] = distinctSenders(["ravi@acme.com"]);
  assert.doesNotMatch(only!.displayName, /ravi@acme\.com/);
});

const coverage0 = { awaitingList: 0, unknownStatus: 0 };
const file = (over: Record<string, unknown> = {}) => ({
  attachmentId: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 100,
  entityId: "m1", threadId: "t1", receivedAt: new Date("2026-10-01T00:00:00Z"),
  sender: "Ravi Kumar <ravi@acme.com>", ...over,
});

test("result files carry no raw sender address", () => {
  const out = shapeFindAttachmentsResult({ files: [file()], matchingSenderHeaders: [], coverage: coverage0, limit: 10 });
  assert.equal(out.files[0]!.sender, "Ravi Kumar");
  assert.doesNotMatch(JSON.stringify(out), /ravi@acme\.com/);
});

test("an unmatched sender is said, not returned as an empty list", () => {
  const out = shapeFindAttachmentsResult({
    files: [], senderQuery: "Zed", matchingSenderHeaders: [], coverage: coverage0, limit: 10,
  });
  assert.equal(out.sender?.matched, 0);
  assert.match(out.note, /No mail from anyone matching "Zed"/);
});

test("two people matching one name: both named, and the model is told to ask", () => {
  const out = shapeFindAttachmentsResult({
    files: [file()],
    senderQuery: "Ravi",
    matchingSenderHeaders: ["Ravi Kumar <r@a.com>", "Ravi Shah <rs@b.com>", "r@a.com"],
    coverage: coverage0, limit: 10,
  });
  assert.equal(out.sender?.matched, 2);
  assert.deepEqual(out.sender?.names, ["Ravi Kumar", "Ravi Shah"]);
  assert.match(out.note, /ask the user which one/);
});

const unchecked7 = { awaitingList: 2, unknownStatus: 5 };
const files = (n: number) => Array.from({ length: n }, (_, i) => file({ attachmentId: `att-${i}` }));

test("a full page with unchecked mail gives no coverage note, but keeps the numbers", () => {
  const out = shapeFindAttachmentsResult({ files: files(10), matchingSenderHeaders: [], coverage: unchecked7, limit: 10 });
  assert.equal(out.note, "");
  assert.deepEqual(out.coverage, unchecked7);
});

test("a short page with unchecked mail states the coverage", () => {
  const out = shapeFindAttachmentsResult({ files: files(3), matchingSenderHeaders: [], coverage: unchecked7, limit: 10 });
  assert.match(out.note, /only covers mail I've checked for attachments; 7 messages in that range weren't checked/);
});

test("zero results with unchecked mail always state the coverage", () => {
  const out = shapeFindAttachmentsResult({ files: [], matchingSenderHeaders: [], coverage: unchecked7, limit: 10 });
  assert.match(out.note, /7 messages in that range weren't checked/);
  const one = shapeFindAttachmentsResult({ files: [], matchingSenderHeaders: [], coverage: { awaitingList: 0, unknownStatus: 1 }, limit: 1 });
  assert.match(one.note, /1 message in that range wasn't checked/);
});

test("nothing unchecked gives no coverage note, even on an empty result", () => {
  assert.equal(shapeFindAttachmentsResult({ files: [], matchingSenderHeaders: [], coverage: coverage0, limit: 10 }).note, "");
  assert.equal(shapeFindAttachmentsResult({ files: files(2), matchingSenderHeaders: [], coverage: coverage0, limit: 10 }).note, "");
});
