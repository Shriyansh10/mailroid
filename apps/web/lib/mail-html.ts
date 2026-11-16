"use client";

import DOMPurify from "dompurify";

/**
 * Sanitising and rewriting untrusted mail HTML for display.
 *
 * Two jobs, both of which have to happen on the same parsed tree, which is why
 * they live in one place rather than two:
 *
 *   1. every link opens in a new tab and cannot reach back into this one;
 *   2. `cid:` references resolve to our own authorized attachment route.
 *
 * Remote images load as the sender wrote them. They are fetched directly from
 * the sender's servers, not through a proxy, so opening a message tells the
 * sender it was read and from which IP address.
 *
 * Both run as DOMPurify hooks, on the SANITISED tree. That ordering is the
 * point: doing any of this with a regex over the raw HTML string would mean
 * pattern-matching attacker-controlled markup and hoping the pattern and the
 * browser's parser agree about where an attribute ends. They frequently do not,
 * and every classic mutation-XSS is that disagreement. Here the browser has
 * already parsed it, DOMPurify has already removed what must go, and we are
 * walking real element nodes.
 */

export interface InlineImage {
  contentId: string;
  id: string;
}

/**
 * Per-render context.
 *
 * A module-level mutable set the hooks read, which is safe for exactly one
 * reason worth stating: `DOMPurify.sanitize` is synchronous and single-threaded,
 * so nothing can interleave between assigning this and the hooks running. It is
 * reset on every call rather than merged, so one message can never inherit the
 * previous message's `cid:` map.
 */
let ctx = {
  cids: new Map<string, string>(),
};

let hooksRegistered = false;

function registerHooks() {
  // DOMPurify has no DOM to hook during server rendering, and registering twice
  // would run every rewrite twice.
  if (hooksRegistered || typeof window === "undefined") return;
  hooksRegistered = true;

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    const tag = el.tagName;

    // ── Links ───────────────────────────────────────────────────────
    //
    // `target="_blank"` alone is reverse tabnabbing: the opened page receives
    // `window.opener` and can navigate the tab it came from to anywhere it
    // likes — a convincing way to replace a mail client with a login page.
    // `noopener` severs that handle; `noreferrer` additionally stops the
    // destination learning which thread the reader came from.
    //
    // Inside the sandboxed frame (mail-frame.tsx) this is also what makes a
    // link work at all: the sandbox allows popups but never navigation of the
    // frame or of Mailroid, so a link that did not open a new tab would do
    // nothing. <area> is an image-map link and needs the same treatment.
    if ((tag === "A" || tag === "AREA") && el.hasAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
    }

    if (tag !== "IMG" && tag !== "SOURCE") return;

    const src = el.getAttribute("src");
    if (!src) return;

    // ── cid: → our own route ────────────────────────────────────────
    if (/^cid:/i.test(src)) {
      // Angle brackets are already stripped when the manifest is parsed, but a
      // body is free to write `cid:<foo@bar>` and some senders do. Decoding
      // handles `%40` for the `@` that nearly every Content-ID contains.
      let key = src.slice(4).replace(/^<|>$/g, "").trim();
      try {
        key = decodeURIComponent(key);
      } catch {
        // A malformed escape is not worth failing a whole message over; fall
        // back to the raw form, which is what most senders emit anyway.
      }

      const id = ctx.cids.get(key) ?? ctx.cids.get(key.toLowerCase());
      if (id) {
        // Same-origin, and behind the same ownership check as every other
        // attachment read. The bytes came with the message, so fetching them
        // tells no third party anything.
        //
        // Absolute, not relative: the body now renders in an `about:srcdoc`
        // document (mail-frame.tsx), and spelling out our own origin leaves no
        // question of what a relative path would resolve against. The frame's
        // CSP admits it as 'self'.
        el.setAttribute("src", `${window.location.origin}/api/attachments/${encodeURIComponent(id)}`);
      } else {
        // Unresolvable: the manifest is not persisted yet, or the sender
        // referenced a part that does not exist. Remove the attribute rather
        // than leaving `cid:` in place — the browser cannot fetch it either way,
        // and a broken-image icon is the honest rendering.
        el.removeAttribute("src");
        el.setAttribute("data-cid-unresolved", key);
      }
    }
  });
}

export interface RenderMailHtmlOptions {
  inlineImages?: InlineImage[] | null;
}

export interface RenderedMailHtml {
  html: string;
}

/**
 * Sanitise one message body for display.
 */
export function renderMailHtml(
  html: string,
  { inlineImages }: RenderMailHtmlOptions = {},
): RenderedMailHtml {
  // NO DOM, NO HTML. With no window, DOMPurify returns a bare factory with
  // `isSupported = false` and NO `sanitize` method at all — calling it throws.
  //
  // Today this component only survives server rendering because its data
  // arrives client-side, so `htmlBody` is empty during SSR and the call never
  // happens. That is safety by accident of data loading, and it would stop
  // being true the moment this thread was server-fetched. Returning empty makes
  // the caller fall back to the plain-text body, which is the one degradation
  // that cannot leak unsanitised markup into the document.
  if (typeof window === "undefined" || !DOMPurify.isSupported) {
    return { html: "" };
  }

  registerHooks();

  ctx = {
    cids: new Map((inlineImages ?? []).map((img) => [img.contentId, img.id])),
  };

  const clean = DOMPurify.sanitize(html, {
    // DOMPurify drops `target` by default, which would make every mail link
    // navigate away from the thread. Adding it back is safe only because the
    // hook above forces rel=noopener, without which target=_blank hands the
    // opened page a handle to ours.
    //
    ADD_ATTR: ["target"],
    // Form controls cannot work in the frame — the sandbox never grants
    // allow-forms — so in mail they only ever serve as decoration, and the
    // decoration they are good for is a convincing "sign in again" form.
    // Their text content is kept (DOMPurify's KEEP_CONTENT), so a label or a
    // button caption still reads.
    FORBID_TAGS: ["form", "input", "textarea", "select", "button"],
  });

  return { html: clean };
}

// ── The sandboxed frame the sanitised body renders in ─────────────────
//
// Sanitising stops script. It does not stop CSS: rendered straight into
// Mailroid's page, a sender's <style> applied to the whole app and a
// position:fixed panel could cover it with a fake "Google session expired"
// prompt. In its own document, the sender's HTML and CSS can only ever lay out
// that document. See components/mail-frame.tsx for the element itself.

/**
 * The frame's sandbox. What is granted, and why — anything not listed is
 * denied: scripts, forms, top-level navigation, modals, downloads, pointer
 * lock, presentation, storage access.
 *
 *   allow-same-origin — the frame shares Mailroid's origin so the parent can
 *     read its height (it sizes to fit) and so inline `cid:` images, served by
 *     /api/attachments behind the session cookie, load. Safe ONLY because
 *     allow-scripts is never granted alongside it: with both, a frame can
 *     remove its own sandbox. Nothing executes in this frame.
 *   allow-popups, allow-popups-to-escape-sandbox — a link opens in a new tab
 *     (rel=noopener noreferrer), which then behaves like any normal page
 *     rather than inheriting this sandbox.
 */
export const MAIL_FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/**
 * Content-Security-Policy inside the frame — a second, independent wall.
 *
 *   default-src 'none' — no script, frame, object, media, connect or font
 *     loads unless listed below.
 *   img-src https: data: 'self' — remote images load as the sender wrote them
 *     (a deliberate product decision, cd5d79b), https only; `data:` for
 *     embedded images; 'self' for inline cid: images via /api/attachments.
 *   style-src 'unsafe-inline' — mail is laid out with inline styles and
 *     <style> blocks; external stylesheets stay blocked.
 *   font-src data: — embedded fonts only; no remote font fetches.
 *   form-action / base-uri 'none' — belt and braces for the sandbox.
 */
export const MAIL_FRAME_CSP = [
  "default-src 'none'",
  "img-src https: data: 'self'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The parent page's look, copied into the frame so mail reads like the app. */
export interface MailFrameLook {
  /** The parent's computed color-scheme. Must match, or the frame paints an opaque backdrop. */
  colorScheme: string;
  color: string;
  linkColor: string;
  fontFamily: string;
  fontSize: string;
}

/**
 * Values come from getComputedStyle on our own page, never from mail, but they
 * are interpolated into a <style> block, so nothing that could end a
 * declaration, a rule or the element survives.
 */
function cssValue(value: string, fallback: string): string {
  const v = value.replace(/[<>{};\\]/g, "").trim();
  return v || fallback;
}

/**
 * The complete `srcdoc` document for one message. `cleanHtml` must already be
 * the output of renderMailHtml — this wraps it, it does not sanitise it.
 */
export function buildMailDocument(cleanHtml: string, look: MailFrameLook): string {
  const scheme = cssValue(look.colorScheme, "normal");
  return [
    "<!doctype html>",
    "<html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${MAIL_FRAME_CSP}">`,
    // Images inside the frame are fetched without a Referer, so a sender's
    // image host never learns the thread URL it was opened from.
    '<meta name="referrer" content="no-referrer">',
    // Every link opens a new tab even if one escaped the sanitiser's rewrite:
    // the sandbox would block it navigating the frame anyway, so without this
    // it would simply do nothing.
    '<base target="_blank">',
    "<style>",
    `:root{color-scheme:${scheme}}`,
    "html,body{margin:0;padding:0;background:transparent}",
    // Wide newsletter tables scroll sideways inside the frame, as they did
    // inside the old overflow-x-auto wrapper; height always fits the content.
    "html{overflow-x:auto}",
    // flow-root: a first paragraph's top margin cannot collapse out of the
    // body, so the body's box is exactly the content the parent measures.
    `body{display:flow-root;color:${cssValue(look.color, "inherit")};font-family:${cssValue(look.fontFamily, "sans-serif")};font-size:${cssValue(look.fontSize, "14px")};line-height:1.5;overflow-wrap:break-word}`,
    `a{color:${cssValue(look.linkColor, "inherit")};text-decoration:underline;text-underline-offset:2px;word-break:break-all}`,
    "a:hover{opacity:.8}",
    "</style>",
    "</head><body>",
    cleanHtml,
    "</body></html>",
  ].join("");
}
