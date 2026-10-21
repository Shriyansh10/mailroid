/**
 * Render tests for the attachment UI: the inbox list never renders attachment
 * bytes, and a thread-view thumbnail renders automatically only when the image
 * is already in object storage.
 *
 *   node --import tsx --test components/attachment-list.test.tsx   (from apps/web)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AttachmentList, InboxAttachmentChips, type MessageAttachment } from "./attachment-list";

const att = (over: Partial<MessageAttachment> = {}): MessageAttachment => ({
  id: "11111111-1111-4111-8111-111111111111",
  partId: "1",
  filename: "photo.png",
  mimeType: "image/png",
  sizeBytes: 20_000,
  ...over,
});

const imgSrcs = (html: string) => [...html.matchAll(/<img[^>]*src="([^"]*)"/g)].map((m) => m[1]);

test("the inbox row renders metadata only: no <img> of attachment bytes, ever", () => {
  const html = renderToStaticMarkup(
    createElement(InboxAttachmentChips, {
      attachments: [
        att({ cached: true }),
        att({ partId: "2", filename: "b.jpg", mimeType: "image/jpeg" }),
        att({ partId: "3", filename: "c.pdf", mimeType: "application/pdf" }),
        att({ partId: "4", filename: "d.docx", mimeType: "application/msword" }),
      ],
    }),
  );
  assert.deepEqual(imgSrcs(html), [], "even an already-stored image is not rendered in a list row");
  assert.match(html, />4<\/span>/, "the attachment count is shown");
  assert.match(html, /1\+/, "the overflow beyond three chips is collapsed");
});

test("an inbox row with no manifest yet shows the paperclip and loads nothing", () => {
  const html = renderToStaticMarkup(createElement(InboxAttachmentChips, { attachments: [], hasAttachment: true }));
  assert.match(html, /Has attachments/);
  assert.deepEqual(imgSrcs(html), []);
});

test("thread view: a STORED image renders its thumbnail", () => {
  const html = renderToStaticMarkup(createElement(AttachmentList, { attachments: [att({ cached: true })] }));
  assert.deepEqual(imgSrcs(html), ["/api/attachments/11111111-1111-4111-8111-111111111111"]);
  assert.doesNotMatch(html, /Load preview/);
});

test("thread view: an image NOT yet stored renders a placeholder and 'Load preview', no <img>", () => {
  for (const cached of [false, undefined]) {
    const html = renderToStaticMarkup(createElement(AttachmentList, { attachments: [att({ cached })] }));
    assert.deepEqual(imgSrcs(html), [], `cached=${cached}`);
    assert.match(html, /Load preview/);
  }
});

test("thread view: a stored image over the thumbnail ceiling still is not auto-rendered", () => {
  const html = renderToStaticMarkup(
    createElement(AttachmentList, { attachments: [att({ cached: true, sizeBytes: 4 * 1024 * 1024 })] }),
  );
  assert.deepEqual(imgSrcs(html), []);
});
