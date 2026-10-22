/**
 * Tests for the thread file strip: known files are listed, checked-empty
 * messages are silent, unchecked messages are counted as unchecked (never as
 * "no files"), and the strip renders no attachment bytes.
 *
 *   node --import tsx --test components/thread-file-strip.test.tsx   (from apps/web)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadFileStrip, summarizeThreadFiles } from "./thread-file-strip";
import type { ThreadMessage } from "./thread-message-list";
import type { MessageAttachment } from "./attachment-list";

const att = (partId: string, filename: string, mimeType = "application/pdf"): MessageAttachment => ({
  id: `id-${partId}`, partId, filename, mimeType, sizeBytes: 2048, cached: true,
});

const msg = (id: string, attachments: MessageAttachment[] | null | undefined): ThreadMessage =>
  ({
    id, from: `Ravi Kumar <ravi@example.com>`, to: "me@example.com", subject: "s",
    date: "2026-10-01T10:00:00Z", body: "", htmlBody: "", snippet: "", attachments,
  }) as ThreadMessage;

const render = (messages: ThreadMessage[]) =>
  renderToStaticMarkup(createElement(ThreadFileStrip, { messages, onReveal: () => {} }));

test("mixed thread: files listed, [] silent, null counted as unchecked", () => {
  const messages = [
    msg("m1", [att("1", "contract.pdf"), att("2", "photo.png", "image/png")]),
    msg("m2", []),
    msg("m3", null),
    msg("m4", undefined),
  ];
  const { files, uncheckedMessages } = summarizeThreadFiles(messages);
  assert.deepEqual(files.map((f) => [f.messageId, f.attachment.filename]), [["m1", "contract.pdf"], ["m1", "photo.png"]]);
  assert.equal(uncheckedMessages, 2);

  const html = render(messages);
  assert.match(html, /2 files in this thread · 2 messages not checked/);
  assert.match(html, /contract\.pdf/);
});

test("all messages checked and empty: nothing renders", () => {
  assert.equal(render([msg("m1", []), msg("m2", [])]), "");
});

test("nothing known: says unchecked, never 'no files'", () => {
  const html = render([msg("m1", null), msg("m2", [])]);
  assert.match(html, /Attachments not checked for 1 message/);
  assert.doesNotMatch(html, /no files|0 files/i);
});

test("the strip never renders attachment bytes or links to them", () => {
  const html = render([msg("m1", [att("1", "photo.png", "image/png")])]);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /\/api\/attachments\//);
});
