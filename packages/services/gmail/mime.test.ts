/**
 * Tests for MIME encoding primitives and the multipart message builder.
 *
 * The single most important case in this file is the FIRST one: that a message
 * with no attachments produces byte-for-byte what it produced before multipart
 * support existed. Every outbound message in the product — new mail, reply,
 * reply-all, forward, both draft paths, everything the assistant composes —
 * goes through buildRawEmail, and almost none of them carry an attachment. A
 * regression there is not a feature that fails; it is mail that stops sending.
 *
 * Everything else here guards an encoding rule whose failure is invisible at
 * the point it happens and only shows up in the recipient's client.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildRawEmail } from "./index.ts";
import {
  base64Lines,
  decodeEncodedWords,
  encodeFilenameParams,
  encodeHeaderValue,
  generateBoundary,
  projectEncodedSize,
  sanitizeFilename,
} from "./mime.ts";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf-8");

// ── The text-only path must not move ──────────────────────────────────

test("a message with no attachments is byte-identical to the pre-multipart output", () => {
  const raw = decode(buildRawEmail("a@b.com", "Hello", "the body", { cc: "c@d.com" }));

  assert.equal(
    raw,
    [
      "To: a@b.com",
      "Cc: c@d.com",
      "Subject: Hello",
      'Content-Type: text/plain; charset="UTF-8"',
      "MIME-Version: 1.0",
      "",
      "the body",
    ].join("\r\n"),
  );
  assert.ok(!raw.includes("multipart"), "no attachments means no multipart wrapper at all");
});

test("an empty attachments array takes the text-only path, not an empty multipart", () => {
  // A caller threading `attachments` through from an optional field will pass
  // [] constantly. That must not silently change the wire format of ordinary
  // mail into a multipart with one part.
  const raw = decode(buildRawEmail("a@b.com", "S", "b", { attachments: [] }));
  assert.ok(!raw.includes("multipart"));
  assert.ok(raw.endsWith("\r\n\r\nb"));
});

// ── multipart/mixed ───────────────────────────────────────────────────

const pdf = { filename: "invoice.pdf", mimeType: "application/pdf", content: Buffer.from("PDFDATA") };

test("one attachment produces a well-formed multipart/mixed", () => {
  const raw = decode(buildRawEmail("a@b.com", "Here", "see attached", { attachments: [pdf] }));

  const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
  assert.ok(boundary, "a boundary must be declared in the Content-Type");

  // Opening delimiter for each part, then the terminator with trailing --.
  assert.equal(raw.split(`--${boundary}\r\n`).length - 1, 2, "one text part + one attachment part");
  assert.ok(raw.includes(`--${boundary}--`), "the closing delimiter is required");

  assert.ok(raw.includes('Content-Disposition: attachment; filename="invoice.pdf"'));
  assert.ok(raw.includes("Content-Type: application/pdf"));
  // The attachment content must appear base64-encoded, never raw.
  assert.ok(raw.includes(Buffer.from("PDFDATA").toString("base64")));
  assert.ok(!raw.includes("PDFDATA"), "raw attachment bytes must not appear unencoded");
});

test("the body is base64-encoded in multipart, so it can never contain the boundary", () => {
  const raw = decode(buildRawEmail("a@b.com", "S", "plain words", { attachments: [pdf] }));
  assert.ok(raw.includes("Content-Transfer-Encoding: base64"));
  assert.ok(
    raw.includes(Buffer.from("plain words", "utf-8").toString("base64")),
    "body must be encoded, not inlined",
  );
});

test("several attachments each get their own part", () => {
  const raw = decode(
    buildRawEmail("a@b.com", "S", "b", {
      attachments: [
        pdf,
        { filename: "notes.txt", mimeType: "text/plain", content: Buffer.from("hello") },
      ],
    }),
  );
  const boundary = raw.match(/boundary="([^"]+)"/)![1]!;
  assert.equal(raw.split(`--${boundary}\r\n`).length - 1, 3, "text part + two attachments");
  assert.ok(raw.includes('filename="notes.txt"'));
});

test("boundaries are unique per message", () => {
  const a = decode(buildRawEmail("a@b.com", "S", "b", { attachments: [pdf] }));
  const b = decode(buildRawEmail("a@b.com", "S", "b", { attachments: [pdf] }));
  assert.notEqual(a.match(/boundary="([^"]+)"/)![1], b.match(/boundary="([^"]+)"/)![1]);
});

test("generateBoundary produces something base64 content cannot contain", () => {
  const boundary = generateBoundary();
  // `_` is outside the base64 alphabet, so an encoded part can never spell it.
  assert.ok(boundary.includes("_"));
  assert.ok(boundary.length > 30, "enough randomness that collision is not a consideration");
});

// ── RFC 2047, header values ───────────────────────────────────────────

test("ASCII subjects are not encoded — encoding them would be noise", () => {
  assert.equal(encodeHeaderValue("Re: Budget Q3"), "Re: Budget Q3");
});

test("a non-ASCII subject becomes an encoded-word and round-trips", () => {
  const subject = "Budget — Q3 café 日本語";
  const encoded = encodeHeaderValue(subject);
  assert.ok(encoded.startsWith("=?UTF-8?B?"));
  assert.equal(decodeEncodedWords(encoded), subject);
});

test("a long non-ASCII subject splits into folded encoded-words that still decode", () => {
  const subject = "日本語".repeat(40);
  const encoded = encodeHeaderValue(subject);

  assert.ok(encoded.includes("\r\n "), "long values must fold");
  for (const word of encoded.split("\r\n ")) {
    assert.ok(word.length <= 75, `encoded-word exceeds the RFC 2047 75-char cap: ${word.length}`);
  }
  // The reason the split is on code points: a word cut mid-UTF-8-sequence
  // decodes to replacement characters in the middle of the reader's subject.
  assert.equal(decodeEncodedWords(encoded), subject);
});

test("an emoji subject survives — splitting must not break a surrogate pair", () => {
  const subject = "🎉".repeat(30);
  assert.equal(decodeEncodedWords(encodeHeaderValue(subject)), subject);
});

test("buildRawEmail encodes the Subject but never the To line", () => {
  const raw = decode(buildRawEmail("José <jose@example.com>", "Café ☕", "body"));
  assert.ok(raw.includes("Subject: =?UTF-8?B?"), "subject is encoded");
  assert.ok(
    raw.includes("To: José <jose@example.com>"),
    "To must stay parseable — an encoded-word is illegal in an addr-spec and no MTA could route it",
  );
});

// ── RFC 2047, decoding inbound ────────────────────────────────────────

test("plain text passes through the decoder untouched", () => {
  assert.equal(decodeEncodedWords("Just a normal subject"), "Just a normal subject");
});

test("the Q encoding is handled, not only B", () => {
  // Real mail uses both. `_` is a space and `=XX` is a hex byte.
  assert.equal(decodeEncodedWords("=?UTF-8?Q?Hello_World?="), "Hello World");
  assert.equal(decodeEncodedWords("=?UTF-8?Q?caf=C3=A9?="), "café");
});

test("charsets other than UTF-8 decode correctly", () => {
  // latin1 0xE9 is é. A sender using ISO-8859-1 is not unusual.
  const encoded = `=?ISO-8859-1?B?${Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64")}?=`;
  assert.equal(decodeEncodedWords(encoded), "café");
});

test("whitespace between adjacent encoded-words is removed, but real spacing survives", () => {
  // RFC 2047 §6.2: the space between two encoded-words is a folding artifact.
  // Getting this wrong inserts a space into the middle of a word.
  const a = `=?UTF-8?B?${Buffer.from("Hello").toString("base64")}?=`;
  const b = `=?UTF-8?B?${Buffer.from("World").toString("base64")}?=`;
  assert.equal(decodeEncodedWords(`${a} ${b}`), "HelloWorld");
  // Between an encoded-word and plain text, the space is content.
  assert.equal(decodeEncodedWords(`${a} plain`), "Hello plain");
});

test("a malformed encoded-word is left as-is rather than throwing", () => {
  const input = "=?UTF-8?X?whatever?= and text";
  assert.equal(decodeEncodedWords(input), input);
});

test("mixed encoded and plain text in one header both survive", () => {
  const encoded = `=?UTF-8?B?${Buffer.from("café").toString("base64")}?=`;
  assert.equal(decodeEncodedWords(`Re: ${encoded} meeting`), "Re: café meeting");
});

// ── RFC 2231, filenames ───────────────────────────────────────────────

test("an ASCII filename emits only the plain form", () => {
  assert.equal(encodeFilenameParams("report.pdf"), 'filename="report.pdf"');
});

test("a non-ASCII filename emits both forms, old clients first", () => {
  const params = encodeFilenameParams("café.pdf");
  assert.ok(params.includes('filename="caf_.pdf"'), "ASCII fallback for old clients");
  assert.ok(params.includes("filename*=UTF-8''caf%C3%A9.pdf"), "RFC 2231 for modern ones");
});

test("filename sanitisation strips traversal, control chars and bidi overrides", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), ".._.._etc_passwd".replace(/^\.+/, ""));
  assert.equal(sanitizeFilename("a\r\nb.txt"), "ab.txt");
  // U+202E is the override that renders `fdp.exe` as `exe.pdf`.
  assert.equal(sanitizeFilename("fdp‮exe.txt"), "fdpexe.txt");
  assert.equal(sanitizeFilename(""), "attachment");
});

test("a quote in a filename cannot break out of the quoted-string", () => {
  const params = encodeFilenameParams('evil".pdf');
  const match = params.match(/^filename="([^"]*)"/);
  assert.ok(match, "the quoted form must remain well-formed");
  assert.ok(!match![1]!.includes('"'));
});

// ── base64 body encoding ──────────────────────────────────────────────

test("base64 output is wrapped at 76 characters", () => {
  const lines = base64Lines(Buffer.alloc(1000, 0x41)).split("\r\n");
  for (const line of lines) assert.ok(line.length <= 76);
  assert.ok(lines.length > 1, "1000 bytes must wrap");
  // And it must still decode to the original.
  assert.ok(Buffer.from(lines.join(""), "base64").equals(Buffer.alloc(1000, 0x41)));
});

// ── projectEncodedSize ────────────────────────────────────────────────

test("projected size accounts for base64 inflation, not raw bytes", () => {
  const tenMB = 10 * 1024 * 1024;
  const projected = projectEncodedSize([{ sizeBytes: tenMB }]);

  assert.ok(projected > tenMB * 1.33, "must reflect the 4/3 base64 expansion");
  assert.ok(projected < tenMB * 1.45, "but not wildly overestimate");
});

test("THE UNITS BUG: 21 MB of raw bytes exceeds a 25 MB ENCODED ceiling", () => {
  // An arithmetic property of base64, and the reason projectEncodedSize exists
  // as one shared helper.
  //
  // NOTE the local constant: 25 MiB is NOT Gmail's message ceiling, and nothing
  // should compare an encoded size to it. Gmail's real API ceiling is 35 MiB
  // (GMAIL_API_MAX_MESSAGE_BYTES); 25 MB is the separate, user-facing allowance
  // for raw FILES. Treating the second as the first is what once capped sending
  // at ~18 MB of attachments — see attachment-limits.ts.
  const GMAIL_LIMIT = 25 * 1024 * 1024;
  const raw = 21 * 1024 * 1024;

  assert.ok(raw < GMAIL_LIMIT, "21 MB raw looks comfortably under the limit");
  assert.ok(
    projectEncodedSize([{ sizeBytes: raw }]) > GMAIL_LIMIT,
    "but encoded it is over, and must be rejected",
  );
});

test("the sum across attachments is what counts, not each one alone", () => {
  const each = 8 * 1024 * 1024;
  const one = projectEncodedSize([{ sizeBytes: each }]);
  const three = projectEncodedSize([{ sizeBytes: each }, { sizeBytes: each }, { sizeBytes: each }]);

  assert.ok(one < 25 * 1024 * 1024, "one 8 MB file fits");
  assert.ok(three > 25 * 1024 * 1024, "three do not — validating per-file would let this through");
});
