"use client";

import DOMPurify from "dompurify";

/**
 * Sanitising and rewriting untrusted mail HTML for display.
 *
 * Three jobs, all of which have to happen on the same parsed tree, which is why
 * they live in one place rather than three:
 *
 *   1. every link opens in a new tab and cannot reach back into this one;
 *   2. `cid:` references resolve to our own authorized attachment route;
 *   3. remote images are blocked until the reader asks for them.
 *
 * All three run as DOMPurify hooks, on the SANITISED tree. That ordering is the
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
 * A 1x1 fully transparent GIF.
 *
 * Used to neutralise a remote `url()` inside CSS while keeping the declaration
 * syntactically valid — deleting the URL text would leave `url()`, which some
 * parsers treat as a malformed rule and drop, taking neighbouring declarations
 * with it. A data URI fires no network request, so the tracking property is the
 * same as removal.
 */
const BLANK_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** `url( … )` with an http(s) target, in either quote style or unquoted. */
const REMOTE_CSS_URL = /url\(\s*(['"]?)\s*(https?:)?\/\/[^)'"]*\1\s*\)/gi;

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
  blockRemote: true,
  blockedCount: 0,
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

    // Counts ELEMENTS neutralised, not attributes.
    //
    // The hook runs once per node, so a boolean here gives exactly that. An
    // image carrying both `src` and `srcset` is one blocked image; incrementing
    // per attribute would tell the reader "2 images blocked" on a message with
    // one, and a count they can see is wrong is worse than no count.
    let blockedHere = false;

    // ── Links ───────────────────────────────────────────────────────
    //
    // `target="_blank"` alone is reverse tabnabbing: the opened page receives
    // `window.opener` and can navigate the tab it came from to anywhere it
    // likes — a convincing way to replace a mail client with a login page.
    // `noopener` severs that handle; `noreferrer` additionally stops the
    // destination learning which thread the reader came from.
    if (tag === "A" && el.hasAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
    }

    // ── CSS url() in a style attribute ──────────────────────────────
    //
    // A tracking pixel does not have to be an <img>. `style="background:
    // url(https://tracker/x.gif)"` fetches just as reliably and is not caught
    // by anything that only inspects img/src.
    if (ctx.blockRemote && el.hasAttribute("style")) {
      const style = el.getAttribute("style")!;
      if (REMOTE_CSS_URL.test(style)) {
        REMOTE_CSS_URL.lastIndex = 0;
        el.setAttribute("style", style.replace(REMOTE_CSS_URL, `url("${BLANK_PIXEL}")`));
        blockedHere = true;
      }
      REMOTE_CSS_URL.lastIndex = 0;
    }

    // ── <style> blocks ──────────────────────────────────────────────
    if (ctx.blockRemote && tag === "STYLE" && el.textContent) {
      const css = el.textContent;
      if (REMOTE_CSS_URL.test(css)) {
        REMOTE_CSS_URL.lastIndex = 0;
        el.textContent = css.replace(REMOTE_CSS_URL, `url("${BLANK_PIXEL}")`);
        blockedHere = true;
      }
      REMOTE_CSS_URL.lastIndex = 0;
    }

    // `background` is the old-HTML table attribute (`<td background="…">`),
    // still extremely common in marketing mail and a plain remote fetch.
    // DOMPurify allows it by default, so without this it would sail through
    // while the <img> next to it was blocked.
    if (ctx.blockRemote && el.hasAttribute("background")) {
      const bg = el.getAttribute("background")!;
      if (/^https?:/i.test(bg)) {
        el.removeAttribute("background");
        blockedHere = true;
      }
    }

    // `poster` is the video preview frame — same fetch, different attribute.
    if (ctx.blockRemote && el.hasAttribute("poster")) {
      const poster = el.getAttribute("poster")!;
      if (/^https?:/i.test(poster)) {
        el.removeAttribute("poster");
        blockedHere = true;
      }
    }

    if (tag !== "IMG" && tag !== "SOURCE") return;

    // `srcset` before `src`, and unconditionally when blocking: a browser that
    // picks a candidate from srcset never consults src at all, so neutralising
    // only src would leave the fetch happening anyway. DOMPurify allows srcset
    // by default, so it does reach us.
    if (ctx.blockRemote && el.hasAttribute("srcset")) {
      el.removeAttribute("srcset");
      blockedHere = true;
    }

    const src = el.getAttribute("src");
    if (!src) {
      if (blockedHere) ctx.blockedCount++;
      return;
    }

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
        // attachment read. This is never gated behind "show images" — the bytes
        // came with the message and fetching them tells no third party anything.
        el.setAttribute("src", `/api/attachments/${encodeURIComponent(id)}`);
      } else {
        // Unresolvable: the manifest is not persisted yet, or the sender
        // referenced a part that does not exist. Remove the attribute rather
        // than leaving `cid:` in place — the browser cannot fetch it either way,
        // and a broken-image icon is the honest rendering.
        el.removeAttribute("src");
        el.setAttribute("data-cid-unresolved", key);
      }
      // A cid: image can still have carried a remote srcset, which the block
      // above stripped. Counting before returning keeps that visible.
      if (blockedHere) ctx.blockedCount++;
      return;
    }

    // ── Remote images ───────────────────────────────────────────────
    //
    // Only http(s) is blocked. `data:` URIs travel inside the message and make
    // no request, so blocking them would cost the reader a visible image and
    // buy no privacy at all.
    if (ctx.blockRemote && /^https?:/i.test(src)) {
      el.removeAttribute("src");
      // Stashed rather than discarded so "show images" can restore it without
      // re-fetching and re-sanitising the message.
      el.setAttribute("data-blocked-src", src);
      blockedHere = true;
    }

    if (blockedHere) ctx.blockedCount++;
  });
}

export interface RenderMailHtmlOptions {
  inlineImages?: InlineImage[] | null;
  /** False (the default) blocks remote images until the reader opts in. */
  showRemoteImages?: boolean;
}

export interface RenderedMailHtml {
  html: string;
  /**
   * How many remote references were neutralised.
   *
   * Drives whether the "images blocked" banner appears at all. A message with
   * none must not show one — an affordance offering to unblock nothing is worse
   * than no affordance, because it teaches the reader to ignore it.
   */
  blockedCount: number;
}

/**
 * Sanitise one message body for display.
 */
export function renderMailHtml(
  html: string,
  { inlineImages, showRemoteImages = false }: RenderMailHtmlOptions = {},
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
    return { html: "", blockedCount: 0 };
  }

  registerHooks();

  ctx = {
    cids: new Map((inlineImages ?? []).map((img) => [img.contentId, img.id])),
    blockRemote: !showRemoteImages,
    blockedCount: 0,
  };

  const clean = DOMPurify.sanitize(html, {
    // DOMPurify drops `target` by default, which would make every mail link
    // navigate away from the thread. Adding it back is safe only because the
    // hook above forces rel=noopener, without which target=_blank hands the
    // opened page a handle to ours.
    //
    // Nothing else is added. `srcset`, `style`, `background` and `poster` are
    // all allowed by DOMPurify 3.4 already — verified against the installed
    // copy rather than assumed, because the blocker's correctness depends on
    // those attributes actually reaching the hook, and an ADD_ATTR entry that
    // is merely redundant today would read as load-bearing later.
    ADD_ATTR: ["target"],
  });

  return { html: clean, blockedCount: ctx.blockedCount };
}
