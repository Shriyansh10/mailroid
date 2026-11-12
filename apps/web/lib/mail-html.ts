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
    if (tag === "A" && el.hasAttribute("href")) {
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
        el.setAttribute("src", `/api/attachments/${encodeURIComponent(id)}`);
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
  });

  return { html: clean };
}
