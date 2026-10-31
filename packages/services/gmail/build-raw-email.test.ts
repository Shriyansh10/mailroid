/**
 * Tests for header sanitisation in the outbound MIME builder.
 *
 * buildRawEmail is the single choke point every outbound message passes
 * through — new mail, reply, reply-all, forward, and both draft paths — and it
 * assembles headers by string interpolation. The failure that matters here is
 * not a malformed message, which is visible; it is a message that sends
 * PERFECTLY while carrying a header the sender never wrote. A subject holding
 * CRLF + "Bcc: someone@else" delivers a silent extra copy and looks completely
 * normal in the compose UI and in the sent-mail view.
 *
 * Subjects reach this function from AI-composed drafts, not only from typing,
 * so these cases are reachable without a malicious user.
 *
 * Control characters are written as escapes or String.fromCharCode throughout.
 * A test about invisible characters must not contain invisible characters — a
 * literal NUL in the source is unreviewable in a diff and one careless
 * copy-paste away from silently becoming a plain space.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildRawEmail, sanitizeHeaderValue } from "./index.ts";
import { decodeEncodedWords } from "./mime.ts";

const CR = "\r";
const LF = "\n";
const CRLF = CR + LF;

/** Decode what buildRawEmail actually hands to Gmail. */
function decode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf-8");
}

/** Header block only — everything before the first blank line. */
function headersOf(raw: string): string[] {
  const text = decode(raw);
  const end = text.indexOf(CRLF + CRLF);
  return text.slice(0, end === -1 ? text.length : end).split(CRLF);
}

test("a CRLF in the subject cannot open a second header", () => {
  const raw = buildRawEmail("a@b.com", `Invoice${CRLF}Bcc: attacker@evil.com`, "hi");
  const headers = headersOf(raw);

  assert.equal(
    headers.filter((h) => h.toLowerCase().startsWith("bcc:")).length,
    0,
    "the smuggled Bcc must not exist as a header",
  );
  // The visible text survives; only the line break is removed. Rejecting the
  // whole send would turn a stray paste into a dead end.
  assert.ok(headers.includes("Subject: InvoiceBcc: attacker@evil.com"));
});

test("a bare CR and a bare LF are both neutralised, not just the pair", () => {
  // A guard written as /\r\n/ passes the test above and fails both of these.
  // Four headers means To, Subject, Content-Type, MIME-Version and nothing else.
  assert.equal(headersOf(buildRawEmail("a@b.com", `x${CR}Bcc: e@e.com`, "b")).length, 4);
  assert.equal(headersOf(buildRawEmail("a@b.com", `x${LF}Bcc: e@e.com`, "b")).length, 4);
});

test("injection through the recipient fields is closed too", () => {
  // `to` is the field an address book or an AI tool is most likely to populate.
  const raw = buildRawEmail(`a@b.com${CRLF}Bcc: attacker@evil.com`, "Hello", "body");
  assert.equal(headersOf(raw).filter((h) => h.toLowerCase().startsWith("bcc:")).length, 0);

  const viaCc = buildRawEmail("a@b.com", "Hello", "body", {
    cc: `c@d.com${CRLF}X-Injected: yes`,
  });
  assert.equal(headersOf(viaCc).filter((h) => h.startsWith("X-Injected")).length, 0);
});

test("the body is left alone — CRLF there is text, not a header boundary", () => {
  const body = `line one${CRLF}line two${CRLF}${CRLF}Bcc: this is just words`;
  const text = decode(buildRawEmail("a@b.com", "S", body));
  assert.ok(text.endsWith(body), "body must round-trip byte for byte");
});

test('"" still means "no header at all", and so does whitespace-only', () => {
  // replyToEmail's override semantics depend on this: "" is how a caller says
  // "drop the Cc", which is not the same as an empty Cc line.
  const headers = headersOf(buildRawEmail("a@b.com", "S", "b", { cc: "", bcc: "   " }));
  assert.equal(headers.filter((h) => h.startsWith("Cc:")).length, 0);
  assert.equal(headers.filter((h) => h.startsWith("Bcc:")).length, 0);
});

test("a real Cc/Bcc/In-Reply-To still comes through untouched", () => {
  const headers = headersOf(
    buildRawEmail("a@b.com", "Re: Budget", "body", {
      cc: "c@d.com, e@f.com",
      bcc: "g@h.com",
      inReplyTo: "<msg-1@mail.gmail.com>",
      references: "<msg-0@mail.gmail.com> <msg-1@mail.gmail.com>",
    }),
  );

  assert.ok(headers.includes("Cc: c@d.com, e@f.com"));
  assert.ok(headers.includes("Bcc: g@h.com"));
  assert.ok(headers.includes("In-Reply-To: <msg-1@mail.gmail.com>"));
  assert.ok(headers.includes("References: <msg-0@mail.gmail.com> <msg-1@mail.gmail.com>"));
});

test("a non-ASCII subject is RFC 2047 encoded, and the decoder reverses it", () => {
  // This test previously asserted the OPPOSITE — that non-ASCII passed through
  // untouched — as a deliberate scope guard while Phase 0 shipped the CR/LF fix
  // without an encoder. Its comment said a later change that started encoding
  // here should fail this test and send whoever made it to the decoder. Phase 3
  // is that change: buildRawEmail now encodes, getHeader now decodes, and the
  // pair has to be asserted together or the round trip is unproven.
  const subject = "Budget — Q3 café 日本語";
  const headers = headersOf(buildRawEmail("a@b.com", subject, "b"));

  const subjectLine = headers.find((h) => h.startsWith("Subject:"))!;
  assert.ok(subjectLine.includes("=?UTF-8?B?"), "must be encoded on the wire");
  assert.equal(
    decodeEncodedWords(subjectLine.slice("Subject: ".length)),
    subject,
    "and must come back out identical — this is what stops a user seeing " +
      "an encoded-word in their own compose box when they reopen a draft",
  );
});

test("sanitizeHeaderValue strips the whole C0 range, not a hand-picked few", () => {
  const NUL = String.fromCharCode(0x00);
  const VT = String.fromCharCode(0x0b);
  const US = String.fromCharCode(0x1f);
  const DEL = String.fromCharCode(0x7f);

  assert.equal(sanitizeHeaderValue(`a${NUL}b${VT}c${US}d${DEL}e`), "abcde");
  assert.equal(sanitizeHeaderValue("  padded  "), "padded");
  assert.equal(sanitizeHeaderValue(`${CR}${LF}\t`), "");

  // 0x20 is the boundary: a space is a legitimate header character and the
  // filter must not take it.
  assert.equal(sanitizeHeaderValue("Re: the budget"), "Re: the budget");

  // Surrogate pairs must survive: iterating UTF-16 units instead of code points
  // would split an emoji into two lone surrogates.
  assert.equal(sanitizeHeaderValue("ok 🎉"), "ok 🎉");
});
