/**
 * The sandbox and CSP contract for rendered mail, and the srcdoc document it
 * is written into. Behaviour in a real browser (scripts blocked, CSS confined,
 * links opening new tabs, inline images loading) is verified separately; this
 * pins the configuration so a later edit cannot quietly widen it.
 *
 *   pnpm --filter web test   (from the repo root)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MAIL_FRAME_CSP, MAIL_FRAME_SANDBOX, buildMailDocument, renderMailHtml, type MailFrameLook } from "./mail-html";

const LOOK: MailFrameLook = {
  colorScheme: "dark",
  color: "rgb(250, 250, 250)",
  linkColor: "oklch(0.7 0.1 250)",
  fontFamily: '"Geist", ui-sans-serif, sans-serif',
  fontSize: "14px",
};

test("sandbox grants exactly same-origin and new-tab popups — never scripts, forms or navigation", () => {
  const tokens = MAIL_FRAME_SANDBOX.split(/\s+/).sort();
  assert.deepEqual(tokens, ["allow-popups", "allow-popups-to-escape-sandbox", "allow-same-origin"]);
  for (const forbidden of [
    "allow-scripts", // with allow-same-origin this would let the frame remove its own sandbox
    "allow-forms",
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation",
    "allow-top-navigation-to-custom-protocols",
    "allow-modals",
    "allow-downloads",
    "allow-storage-access-by-user-activation",
  ]) {
    assert.ok(!tokens.includes(forbidden), `${forbidden} must never be granted`);
  }
});

test("CSP: nothing loads unless listed, images are https/data/self only, no script source at all", () => {
  const directives = Object.fromEntries(
    MAIL_FRAME_CSP.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values];
    }),
  );
  assert.deepEqual(directives["default-src"], ["'none'"]);
  assert.deepEqual(directives["img-src"], ["https:", "data:", "'self'"]);
  assert.deepEqual(directives["style-src"], ["'unsafe-inline'"]);
  assert.deepEqual(directives["font-src"], ["data:"]);
  assert.deepEqual(directives["form-action"], ["'none'"]);
  assert.deepEqual(directives["base-uri"], ["'none'"]);
  assert.equal(directives["script-src"], undefined, "no script source may be listed");
  assert.ok(!/http:(?!\/)/.test(MAIL_FRAME_CSP.replace("https:", "")), "plain http: is never allowed");
});

test("the document puts the CSP first, before any mail content can appear", () => {
  const doc = buildMailDocument("<p>hello</p>", LOOK);
  const csp = doc.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(csp > 0 && csp < doc.indexOf("<body>"), "CSP meta must be in <head>");
  assert.ok(doc.includes(`content="${MAIL_FRAME_CSP}"`));
  assert.ok(doc.includes('<meta name="referrer" content="no-referrer">'));
  assert.ok(doc.includes('<base target="_blank">'));
  assert.ok(doc.endsWith("<body><p>hello</p></body></html>"));
});

test("the copied look matches the app's color-scheme, so the frame stays transparent", () => {
  assert.match(buildMailDocument("", LOOK), /:root\{color-scheme:dark\}/);
  assert.match(buildMailDocument("", { ...LOOK, colorScheme: "" }), /:root\{color-scheme:normal\}/);
});

test("look values cannot break out of the <style> block", () => {
  const doc = buildMailDocument("<p>x</p>", {
    ...LOOK,
    color: "red;}</style><script>alert(1)</script><style>{",
    fontFamily: "x}body{display:none",
  });
  assert.equal(doc.match(/<\/style>/g)?.length, 1, "only the builder's own </style>");
  assert.doesNotMatch(doc, /<script/);
  assert.doesNotMatch(doc, /\}body\{display:none/);
});

test("with no DOM to sanitise against, renderMailHtml returns nothing rather than raw HTML", () => {
  // Node has no window: the caller must fall back to the text body.
  assert.deepEqual(renderMailHtml('<img src=x onerror="alert(1)"><p>hi</p>'), { html: "" });
});
