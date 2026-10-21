import React from "react";

/**
 * URLs and bare addresses in plain-text mail.
 *
 * Deliberately conservative. Plain-text bodies are untrusted sender content, so
 * this only ever matches things it can turn into a safe href — an explicit
 * scheme, a `www.` host, or a mail address. Anything it does not recognise stays
 * text, which is the correct failure direction.
 */
const PATTERN =
  /((?:https?:\/\/|www\.)[^\s<>()[\]{}"']+[^\s<>()[\]{}"'.,;:!?])|([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

/** Schemes that may become an href. Everything else — `javascript:`, `data:`,
 *  `vbscript:` — is rendered as inert text rather than sanitised, because there
 *  is no version of those a mail body has a legitimate reason to carry. */
function safeHref(raw: string): string | null {
  if (raw.includes("@") && !raw.includes("/")) return `mailto:${raw}`;
  const withScheme = raw.startsWith("www.") ? `https://${raw}` : raw;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Turn plain text into React nodes with clickable links.
 *
 * Returns nodes rather than an HTML string on purpose: nothing here is ever
 * handed to `dangerouslySetInnerHTML`, so a body that happens to contain markup
 * cannot become markup. React escapes every text segment for us.
 */
export function linkifyText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  PATTERN.lastIndex = 0;
  while ((match = PATTERN.exec(text)) !== null) {
    const raw = match[0];
    const href = safeHref(raw);

    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (href) {
      nodes.push(
        <a
          key={`${match.index}-${raw}`}
          href={href}
          target="_blank"
          // noreferrer as well as noopener: a mail link should not leak which
          // thread the reader came from to the destination.
          rel="noopener noreferrer nofollow"
          className="text-primary underline underline-offset-2 hover:opacity-80 break-all"
        >
          {raw}
        </a>,
      );
    } else {
      nodes.push(raw);
    }

    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
