/**
 * Render tests for Dobbie's file results card: it shows metadata only (no
 * <img>, so displaying it downloads nothing), offers Open only for types the
 * bytes route renders inline, and every link goes through that authorized
 * route or to the thread.
 *
 *   node --import tsx --test components/attachment-results-card.test.tsx   (from apps/web)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AttachmentResultsCard } from "./attachment-results-card";
import type { AttachmentResultsRef } from "@web/lib/assistant/tool-memory";

const file = (over: Partial<AttachmentResultsRef["files"][number]> = {}): AttachmentResultsRef["files"][number] => ({
  attachmentId: "11111111-1111-1111-1111-111111111111",
  filename: "invoice.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  threadId: "thread-1",
  receivedAt: "2026-10-01T10:00:00.000Z",
  sender: "Ravi Kumar",
  ...over,
});

const render = (files: AttachmentResultsRef["files"]) =>
  renderToStaticMarkup(createElement(AttachmentResultsCard, { results: { files } }));

test("metadata only: no <img>, even for images", () => {
  const html = render([file({ filename: "photo.png", mimeType: "image/png" })]);
  assert.doesNotMatch(html, /<img/);
});

test("a previewable file gets Open, Download and the thread", () => {
  const html = render([file()]);
  assert.match(html, /href="\/api\/attachments\/11111111-1111-1111-1111-111111111111"/);
  assert.match(html, /href="\/api\/attachments\/11111111-1111-1111-1111-111111111111\?download=1"/);
  assert.match(html, /href="\/inbox\/thread-1"/);
  assert.match(html, /Ravi Kumar/);
});

test("a type the route will not render inline gets Download only", () => {
  const html = render([file({ filename: "deck.pptx", mimeType: "application/vnd.ms-powerpoint" })]);
  assert.doesNotMatch(html, /Open deck\.pptx/);
  assert.match(html, /\?download=1/);
});

test("every link stays on the authorized route or the inbox", () => {
  const html = render([file(), file({ attachmentId: "22222222-2222-2222-2222-222222222222", threadId: null })]);
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(hrefs.length > 0);
  for (const href of hrefs) assert.match(href, /^\/(api\/attachments\/|inbox\/)/);
});

test("an empty result renders nothing", () => {
  assert.equal(render([]), "");
});
