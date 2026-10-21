/**
 * Tests for body extraction from a nested MIME payload.
 *
 * The failure mode here is not a crash or an empty screen — it is a message
 * that renders CONFIDENTLY WRONG CONTENT. A mail carrying an attached `.eml`
 * has two complete bodies in its part tree, and a depth-first walk that does
 * not know where the message stops will happily show the reader the attachment's
 * body as though it were the mail they opened. Nothing looks broken.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { extractBody, type MessagePart } from "./index.ts";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

/** A leaf part carrying inline content, the way a real body part arrives. */
function bodyPart(mimeType: string, text: string): MessagePart {
  return { mimeType, body: { data: b64(text), size: text.length } };
}

test("a simple text/plain body is read from the payload itself", () => {
  assert.equal(extractBody(bodyPart("text/plain", "hello there")), "hello there");
});

test("text/plain is preferred over text/html in multipart/alternative", () => {
  const payload: MessagePart = {
    mimeType: "multipart/alternative",
    parts: [bodyPart("text/plain", "plain version"), bodyPart("text/html", "<p>html version</p>")],
  };
  assert.equal(extractBody(payload), "plain version");
});

test("html is used, tags stripped, when there is no plain part", () => {
  const payload: MessagePart = {
    mimeType: "multipart/alternative",
    parts: [bodyPart("text/html", "<p>hello <b>world</b></p>")],
  };
  assert.equal(extractBody(payload), "hello world");
});

test("THE .eml CASE: an attached message never supplies the body", () => {
  // multipart/mixed[ the real body, an attached email that has its own body ].
  // A depth-first walk that recurses into message/rfc822 finds the attachment's
  // text/plain too — and if the real body were html-only, would prefer it.
  const payload: MessagePart = {
    mimeType: "multipart/mixed",
    parts: [
      bodyPart("text/html", "<p>the actual message</p>"),
      {
        mimeType: "message/rfc822",
        filename: "forwarded.eml",
        parts: [bodyPart("text/plain", "CONTENT OF THE ATTACHED EMAIL")],
      },
    ],
  };

  const result = extractBody(payload);
  assert.equal(result, "the actual message");
  assert.ok(
    !result.includes("ATTACHED"),
    "the attached email's body must never be presented as this message's body",
  );
});

test("a text/plain part marked Content-Disposition: attachment is not the body", () => {
  // An attached .txt file is text, and is exactly the right MIME type to be
  // mistaken for a body.
  const payload: MessagePart = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "text/plain",
        filename: "notes.txt",
        headers: [{ name: "Content-Disposition", value: 'attachment; filename="notes.txt"' }],
        body: { data: b64("CONTENTS OF AN ATTACHED FILE"), size: 28 },
      },
      bodyPart("text/plain", "the actual message"),
    ],
  };

  assert.equal(extractBody(payload), "the actual message");
});

test("a part delivered by attachmentId is not the body, whatever its type", () => {
  // A body always arrives inline in body.data. A part with an attachmentId is
  // fetched separately, which is what makes it a document.
  const payload: MessagePart = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/html", filename: "report.html", body: { attachmentId: "att-1", size: 900 } },
      bodyPart("text/html", "<p>the actual message</p>"),
    ],
  };

  assert.equal(extractBody(payload), "the actual message");
});

test("the search continues past a same-type part that carries no content", () => {
  // The previous walk returned the first MIME-type match and left the caller to
  // notice it was empty — and the caller's only move was to give up, so the
  // message rendered with no body at all.
  const payload: MessagePart = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { size: 0 } },
      bodyPart("text/plain", "the actual message"),
    ],
  };

  assert.equal(extractBody(payload), "the actual message");
});

test("a body nested two containers deep is still found", () => {
  // multipart/mixed > multipart/related > multipart/alternative is the ordinary
  // shape of marketing mail with an inline logo and an attachment. Hardening
  // must not have turned the walk into a shallow one.
  const payload: MessagePart = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/related",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              bodyPart("text/plain", "deeply nested body"),
              bodyPart("text/html", "<p>deeply nested body</p>"),
            ],
          },
          {
            mimeType: "image/png",
            filename: "logo.png",
            body: { attachmentId: "att-logo", size: 100 },
          },
        ],
      },
      { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "att-1", size: 5000 } },
    ],
  };

  assert.equal(extractBody(payload), "deeply nested body");
});

test("no body at all returns empty rather than reaching for an attachment", () => {
  const payload: MessagePart = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "message/rfc822",
        filename: "only-an-attachment.eml",
        parts: [bodyPart("text/plain", "ATTACHED BODY")],
      },
    ],
  };

  assert.equal(extractBody(payload), "");
});
