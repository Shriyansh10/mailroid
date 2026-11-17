"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import {
  MAIL_FRAME_SANDBOX,
  buildMailDocument,
  renderMailHtml,
  type InlineImage,
  type MailFrameLook,
} from "@web/lib/mail-html";

/**
 * One message's HTML body, isolated in a sandboxed iframe.
 *
 * The body is sanitised first (renderMailHtml — DOMPurify, links forced to new
 * tabs, cid: images resolved), then rendered as the srcdoc of an iframe whose
 * sandbox and CSP are defined next to the sanitiser in lib/mail-html.ts. The
 * sanitiser stops script; the frame confines everything the sanitiser has to
 * let through — the sender's CSS and layout — to its own document, so mail can
 * never restyle or cover Mailroid.
 *
 * Sized to its content: allow-same-origin lets this component read the frame's
 * body height (scripts inside stay blocked). It is measured on load (which
 * waits for images), while the document is still loading, and whenever the
 * frame's width changes. If measuring ever fails the frame keeps the browser's
 * default height and scrolls — degraded, never invisible.
 */
export function MailFrame({
  html,
  inlineImages,
  fallback,
}: {
  html: string;
  inlineImages?: InlineImage[] | null;
  /** Rendered when there is no HTML to show, or no DOM to sanitise against (SSR). */
  fallback: ReactNode;
}) {
  const clean = useMemo(() => renderMailHtml(html, { inlineImages }).html, [html, inlineImages]);

  const probeRef = useRef<HTMLDivElement>(null);
  const linkProbeRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Re-read on theme change: the copied colours are baked into the srcdoc.
  const { resolvedTheme } = useTheme();
  const [look, setLook] = useState<MailFrameLook | null>(null);
  useEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;
    const own = getComputedStyle(probe);
    setLook({
      colorScheme: getComputedStyle(document.documentElement).colorScheme || "normal",
      color: own.color,
      linkColor: linkProbeRef.current ? getComputedStyle(linkProbeRef.current).color : own.color,
      fontFamily: own.fontFamily,
      fontSize: own.fontSize,
    });
  }, [resolvedTheme, clean]);

  const srcDoc = useMemo(() => (clean && look ? buildMailDocument(clean, look) : null), [clean, look]);

  const [height, setHeight] = useState<number | undefined>(undefined);
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!doc?.body || !win) return;
    const content = doc.body.getBoundingClientRect().height;
    // A horizontal scrollbar (wide newsletter table) takes height of its own.
    const scrollbar = Math.max(0, win.innerHeight - doc.documentElement.clientHeight);
    const next = Math.ceil(content + scrollbar);
    if (next > 0) setHeight((prev) => (prev === next ? prev : next));
  }, []);

  // While the document loads, keep measuring so text appears at its size
  // before slow remote images finish (the load event waits for those).
  useEffect(() => {
    if (!srcDoc) return;
    const timer = window.setInterval(measure, 200);
    const stop = window.setTimeout(() => window.clearInterval(timer), 10_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [srcDoc, measure]);

  // A width change (sidebar, window, panel) reflows the mail. Height changes
  // are ignored here: they are this component's own doing.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    let lastWidth = frame.clientWidth;
    const observer = new ResizeObserver(() => {
      if (frame.clientWidth !== lastWidth) {
        lastWidth = frame.clientWidth;
        measure();
      }
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [srcDoc, measure]);

  if (!clean) return <>{fallback}</>;

  return (
    // The probe carries the classes the old inline body had, so the frame
    // copies the same colour, size and font.
    <div ref={probeRef} className="max-w-full text-foreground text-sm">
      <span ref={linkProbeRef} className="hidden text-primary" aria-hidden />
      {srcDoc && (
        <iframe
          ref={frameRef}
          title="Email message"
          srcDoc={srcDoc}
          sandbox={MAIL_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={measure}
          className="block w-full border-0"
          style={height === undefined ? undefined : { height }}
        />
      )}
    </div>
  );
}
