/**
 * Tests for outgoing-attachment limits and type rules.
 *
 * The failure this file guards is a SILENT DEAD BAND: a range of message sizes
 * that passes our validation and is then refused by Gmail, or is refused by us
 * when Gmail would have accepted it. Both look like "sending is broken
 * sometimes" and neither shows up unless a test states the boundary in the same
 * unit the limit is expressed in.
 *
 * This repo has already paid for that mistake once on the read path, where a
 * 25 MiB size gate met a 64 MiB budget charged at 4x and made every attachment
 * between 16 and 25 MiB permanently undownloadable while 155 tests passed.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  GMAIL_API_MAX_MESSAGE_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_RAW_BYTES,
  MAX_UPLOAD_BYTES,
  isUninspectableArchive,
  validateOutgoingAttachments,
} from "./attachment-limits.ts";
import { projectEncodedSize } from "./mime.ts";

const MB = 1024 * 1024;
const file = (filename: string, sizeBytes: number) => ({ filename, sizeBytes });

// ── The two ceilings, and the gap between them ────────────────────────
//
// The bug these guard: applying Gmail's user-facing 25 MB ATTACHMENT allowance
// to the ENCODED MESSAGE. That capped sending at ~18.3 MB of files and rejected
// sets Gmail itself accepts — a 24.8 MB selection encodes to ~33.9 MB, over a
// 25 MB ceiling and comfortably under the real 35 MiB one.

test("the API ceiling is the value Google's discovery document declares", () => {
  // Not prose, not a blog: users.messages.send / drafts.create / drafts.update /
  // drafts.send all declare mediaUpload.maxSize = 36700160 in
  // https://gmail.googleapis.com/$discovery/rest?version=v1
  //
  // Pinned exactly, because every other number here is justified against it. If
  // Google ever changes it, this test is the thing that should fail first.
  assert.equal(GMAIL_API_MAX_MESSAGE_BYTES, 36_700_160);
  assert.equal(GMAIL_API_MAX_MESSAGE_BYTES, 35 * MB, "which is exactly 35 MiB");
});

test("the attachment allowance matches the 25 MB Gmail tells users", () => {
  // A product promise, not arithmetic. Mailroid and Gmail must not disagree
  // about the same mailbox — the user believes Gmail.
  assert.equal(MAX_TOTAL_RAW_BYTES, 25 * MB);
});

test("A FULL 25 MB OF FILES STILL FITS THE API CEILING, WITH HEADROOM", () => {
  // THE LOAD-BEARING TEST. MAX_TOTAL_RAW_BYTES is written down rather than
  // derived, so this is what stops it becoming a promise the transport cannot
  // keep. If someone widens per-part overhead in mime.ts far enough to eat the
  // margin, this fails here instead of at Gmail, on a real send, in production.
  //
  // Worst realistic shape: the full allowance as ONE part with a maximum-length
  // filename (sanitizeFilename caps at 200).
  const projected = projectEncodedSize([
    { sizeBytes: MAX_TOTAL_RAW_BYTES, filename: "x".repeat(200) },
  ]);

  assert.ok(
    projected <= GMAIL_API_MAX_MESSAGE_BYTES,
    `a full ${MAX_TOTAL_RAW_BYTES} bytes of files projects to ${projected}, over the ` +
      `${GMAIL_API_MAX_MESSAGE_BYTES} ceiling — the advertised limit is undeliverable`,
  );

  // And not by a hair. 0.79 MiB at the time of writing; requiring half a MiB
  // leaves room for headers this estimate does not model (a long Cc list, a
  // deep References chain) without pinning the exact figure.
  const headroom = GMAIL_API_MAX_MESSAGE_BYTES - projected;
  assert.ok(
    headroom >= 512 * 1024,
    `only ${headroom} bytes of headroom — too thin to absorb unmodelled headers`,
  );
});

test("base64 inflation is ~37%, so the two ceilings cannot be the same number", () => {
  const projected = projectEncodedSize([{ sizeBytes: MAX_TOTAL_RAW_BYTES }]);
  const factor = projected / MAX_TOTAL_RAW_BYTES;

  assert.ok(factor > 1.33, "4/3 at minimum");
  assert.ok(factor < 1.40, "plus line breaks and part overhead, not more");
  // Which is precisely why 25 MB of files needs a ceiling well above 25 MB.
  assert.ok(projected > MAX_TOTAL_RAW_BYTES);
});

test("the upload body cap leaves room for the message around the files", () => {
  assert.ok(MAX_UPLOAD_BYTES > MAX_TOTAL_RAW_BYTES, "body, headers and field names need space");
  assert.ok(MAX_UPLOAD_BYTES < MAX_TOTAL_RAW_BYTES * 1.5, "but not an open-ended allowance");
});

// ── Size validation ───────────────────────────────────────────────────

test("an ordinary attachment passes", () => {
  assert.deepEqual(validateOutgoingAttachments([file("invoice.pdf", 2 * MB)]), { ok: true });
});

// ── The Stage 1.4 regression cases ────────────────────────────────────
//
// Every one of these was rejected before the ceiling was corrected, and every
// one of them is something Gmail's own composer accepts.

test("REGRESSION: a 21 MB file sends — it did not, under the old ceiling", () => {
  // 21 MB encodes to ~28.7 MiB: over the old (wrong) 25 MB ceiling, well under
  // the real 35 MiB one. This is the case from the bug report.
  assert.equal(validateOutgoingAttachments([file("video.mp4", 21 * MB)]).ok, true);
});

test("REGRESSION: 24.8 MB of files sends, exactly as Gmail allows", () => {
  // The reported set: 21 MB + 3.8 MB, which the UI described as becoming
  // "about 33.9 MB once encoded" and refused. 33.9 MiB is under 35 MiB.
  const verdict = validateOutgoingAttachments([
    file("big.mp4", 21 * MB),
    file("deck.pdf", Math.round(3.8 * MB)),
  ]);
  assert.equal(verdict.ok, true);
});

test("REGRESSION: three and four 5 MB files both send", () => {
  const five = (n: number) => Array.from({ length: n }, (_, i) => file(`f${i}.pdf`, 5 * MB));
  assert.equal(validateOutgoingAttachments(five(3)).ok, true);
  assert.equal(validateOutgoingAttachments(five(4)).ok, true);
});

// ── The size boundary ─────────────────────────────────────────────────

test("the boundary is exact: 25 MB passes, one byte more does not", () => {
  // Both sides asserted. A limit that only ever gets tested from far away is a
  // limit nobody has actually checked.
  assert.equal(validateOutgoingAttachments([file("a.pdf", MAX_TOTAL_RAW_BYTES)]).ok, true);

  const over = validateOutgoingAttachments([file("a.pdf", MAX_TOTAL_RAW_BYTES + 1)]);
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.code, "size");
});

test("one byte over does not render as '25.0 MB exceeds 25.0 MB'", () => {
  // Rounding to one decimal made the rejection state a contradiction and gave
  // the user nothing to act on. Precision must widen until the two differ.
  const verdict = validateOutgoingAttachments([file("a.pdf", MAX_TOTAL_RAW_BYTES + 1)]);
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;

  const numbers = verdict.reason.match(/[\d,]+(?:\.\d+)?\s*(?:MB|bytes)/g) ?? [];
  assert.ok(numbers.length >= 2, "the message must quote both the total and the limit");
  assert.notEqual(numbers[0], numbers[1], `both sides rendered as ${numbers[0]}`);
});

test("the sum is validated, not each file alone", () => {
  // Three 10 MB files: each is fine, the set is not. Per-file validation is the
  // obvious implementation and it is wrong.
  const each = 10 * MB;
  assert.equal(validateOutgoingAttachments([file("a.pdf", each)]).ok, true);
  assert.equal(
    validateOutgoingAttachments([file("a.pdf", each), file("b.pdf", each), file("c.pdf", each)]).ok,
    false,
  );
});

test("the body text counts toward the encoded total", () => {
  // A long quoted forward is not free. Passing bodyBytes is what stops a message
  // that fits on its attachments alone from failing at Gmail. This is the ONLY
  // way to breach the encoded ceiling while staying inside the raw allowance.
  const attachments = [file("a.pdf", MAX_TOTAL_RAW_BYTES - 1000)];
  assert.equal(validateOutgoingAttachments(attachments, 0).ok, true);
  assert.equal(validateOutgoingAttachments(attachments, 2 * MB).ok, false);
});

test("attachments alone can never trigger the message-size message", () => {
  // The two rules must not both be reachable from the same input, or the user
  // gets told to shorten their text when the real problem is a file. Raw is
  // checked first and its ceiling is low enough that the encoded rule is
  // unreachable without a body.
  const verdict = validateOutgoingAttachments([file("a.pdf", MAX_TOTAL_RAW_BYTES)], 0);
  assert.equal(verdict.ok, true, "the full allowance with no body must pass both rules");
});

test("the size message quotes numbers the sender can act on", () => {
  const verdict = validateOutgoingAttachments([file("big.zip", 31 * MB)]);
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  // "Send failed" tells a user nothing. Each of these is a number they can use.
  assert.match(verdict.reason, /31\.0 MB/, "what they attached");
  assert.match(verdict.reason, /25\.0 MB/, "what the limit is");
});

test("the size message rules out the Drive fallback the user expects from Gmail", () => {
  // Gmail offers Drive at this exact moment. Mailroid deliberately does not, and
  // silence would read as a bug rather than a decision.
  const verdict = validateOutgoingAttachments([file("big.zip", 31 * MB)]);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /Drive/i);
});

// ── Blocked types ─────────────────────────────────────────────────────

test("Gmail's blocked executable types are refused before any send", () => {
  for (const name of ["setup.exe", "run.bat", "lib.dll", "installer.msi", "app.jar", "x.vbs"]) {
    const verdict = validateOutgoingAttachments([file(name, 1000)]);
    assert.equal(verdict.ok, false, `${name} must be refused`);
    assert.equal(verdict.ok === false && verdict.code, "type");
  }
});

test("the extension check is case-insensitive", () => {
  assert.equal(validateOutgoingAttachments([file("SETUP.EXE", 1000)]).ok, false);
  assert.equal(validateOutgoingAttachments([file("Setup.ExE", 1000)]).ok, false);
});

test("ordinary document types are not caught by the blocklist", () => {
  for (const name of ["report.pdf", "sheet.xlsx", "photo.jpg", "notes.txt", "archive.zip"]) {
    assert.equal(validateOutgoingAttachments([file(name, 1000)]).ok, true, `${name} must pass`);
  }
});

test("the blocked-type message says why a zip will not help", () => {
  const verdict = validateOutgoingAttachments([file("setup.exe", 1000)]);
  assert.equal(verdict.ok, false);
  // Gmail inspects archives, including password-protected ones. A user who is
  // only told ".exe is blocked" will zip it and hit the same wall.
  if (!verdict.ok) assert.match(verdict.reason, /zip|archive/i);
});

test("an archive is flagged as uninspectable rather than blocked", () => {
  // We never open an archive — Mailroid does not parse attachment content at
  // all — so we cannot know whether Gmail will reject it.
  assert.equal(isUninspectableArchive("bundle.zip"), true);
  assert.equal(isUninspectableArchive("backup.tar.gz"), true);
  assert.equal(isUninspectableArchive("report.pdf"), false);
  // And flagging must not mean refusing.
  assert.equal(validateOutgoingAttachments([file("bundle.zip", 1000)]).ok, true);
});

// ── Count and degenerate cases ────────────────────────────────────────

test("too many files is refused with the count in the message", () => {
  const many = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, i) => file(`f${i}.txt`, 10));
  const verdict = validateOutgoingAttachments(many);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "count");
  if (!verdict.ok) assert.match(verdict.reason, new RegExp(String(MAX_ATTACHMENT_COUNT)));
});

test("an empty file is refused rather than sent as a zero-byte part", () => {
  const verdict = validateOutgoingAttachments([file("empty.txt", 0)]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.code, "empty");
});

test("no attachments at all is valid — this path is shared with plain mail", () => {
  assert.deepEqual(validateOutgoingAttachments([]), { ok: true });
});

test("a file with no extension is not mistaken for a blocked type", () => {
  assert.equal(validateOutgoingAttachments([file("README", 100)]).ok, true);
  assert.equal(validateOutgoingAttachments([file("archive.tar.gz", 100)]).ok, true);
});
