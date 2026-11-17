/**
 * MailFrame and the thread view that uses it.
 *
 *   node --import tsx --test components/mail-frame.test.tsx   (from apps/web)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MailFrame } from "./mail-frame";

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

test("on the server (no DOM) it renders the text fallback, never the HTML", () => {
  const html = renderToStaticMarkup(
    createElement(MailFrame, {
      html: '<p>Hello</p><img src="https://tracker.example/p.gif"><style>body{display:none}</style>',
      fallback: createElement("div", { "data-fallback": true }, "Hello (text)"),
    }),
  );
  assert.equal(html, '<div data-fallback="true">Hello (text)</div>');
});

test("the frame is created with the shared sandbox and no inline-HTML escape hatch", () => {
  const src = source("./mail-frame.tsx");
  assert.match(src, /sandbox=\{MAIL_FRAME_SANDBOX\}/);
  assert.match(src, /srcDoc=\{srcDoc\}/);
  assert.match(src, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
});

test("no message body is injected into Mailroid's own DOM any more", () => {
  for (const file of ["./thread-message-list.tsx", "./email-reference-card.tsx"]) {
    assert.doesNotMatch(source(file), /dangerouslySetInnerHTML/, `${file} renders HTML inline`);
  }
  assert.match(source("./thread-message-list.tsx"), /<MailFrame /);
});
