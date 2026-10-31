/**
 * Response-header and filename hardening for attachment delivery.
 *
 * Everything here treats the sender as hostile, because anyone who can email
 * you can choose these values. `filename` and `mime_type` come straight off the
 * wire; neither has ever been validated by anybody.
 *
 * Pure functions only: no I/O, so all of it is directly testable.
 */

/**
 * Types we are willing to render in the browser.
 *
 * `image/svg+xml` is deliberately ABSENT and must stay absent. SVG is a script
 * container — an inline SVG executes JavaScript in Mailroid's own origin, where
 * it can read the session cookie. The same reasoning excludes text/html.
 */
const INLINE_ALLOWLIST = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

/**
 * Leading bytes each inline-eligible type must actually start with.
 *
 * This is what stops a declared type from being taken on trust: an HTML file
 * renamed `report.pdf` and served as `application/pdf` would otherwise be
 * rendered by the browser, and `nosniff` does not help when the *declared*
 * type is the lie.
 *
 * text/plain has no signature and is absent by design — see canServeInline.
 */
const MAGIC: Record<string, readonly (readonly number[])[]> = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  ],
  // RIFF....WEBP — bytes 8..11 carry the format, so this one is checked in two
  // pieces rather than as a single prefix.
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
};

/** How many leading bytes any check needs. Bounds the sniff on a stream. */
export const MAGIC_SNIFF_BYTES = 16;

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

/** Normalise a declared type: strip parameters, lowercase, trim. */
export function normalizeMimeType(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Does the content match the type it claims to be?
 *
 * Unknown types return false — they were never inline-eligible anyway, and a
 * default of "true" here would be the wrong way round.
 */
export function magicBytesMatch(mimeType: string, head: Uint8Array): boolean {
  const type = normalizeMimeType(mimeType);

  if (type === "text/plain") {
    // No signature exists. Safe inline regardless, because the combination of
    // an explicit `text/plain` type and `nosniff` stops the browser treating
    // markup in the body as markup.
    return true;
  }

  if (type === "image/webp") {
    return (
      startsWith(head, MAGIC["image/webp"]![0]!) &&
      head.length >= 12 &&
      head[8] === 0x57 && // W
      head[9] === 0x45 && // E
      head[10] === 0x42 && // B
      head[11] === 0x50 // P
    );
  }

  const sigs = MAGIC[type];
  if (!sigs) return false;
  return sigs.some((sig) => startsWith(head, sig));
}

/**
 * Decide the disposition and the type we will actually declare.
 *
 * Default is `attachment`. Inline requires BOTH an allowlisted type and content
 * that matches it; anything else is downgraded to `application/octet-stream`
 * plus `attachment`, which no browser will render.
 */
export function resolveDisposition(
  declaredMimeType: string,
  head: Uint8Array | null,
  wantInline: boolean,
): { disposition: "inline" | "attachment"; contentType: string } {
  const type = normalizeMimeType(declaredMimeType);

  if (!wantInline || !INLINE_ALLOWLIST.has(type)) {
    // Note the declared type is NOT echoed back for a download. Serving
    // `text/html` with `attachment` would still be safe in every current
    // browser, but octet-stream removes the question entirely.
    return { disposition: "attachment", contentType: "application/octet-stream" };
  }

  if (head && !magicBytesMatch(type, head)) {
    return { disposition: "attachment", contentType: "application/octet-stream" };
  }

  return { disposition: "inline", contentType: type };
}

/**
 * Characters that must never reach a filename we display or send.
 *
 * The bidi overrides are the non-obvious ones: U+202E and friends reorder the
 * rendering of everything after them, which is how `fdp.exe` is made to display
 * as `exe.pdf`. Stripping them means the chip shows the real extension.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const MAX_FILENAME_LENGTH = 120;

/**
 * Make a sender-supplied filename safe to display and to put in a header.
 *
 * CR and LF are the security-critical removals: unescaped, they let a filename
 * inject its own headers into the response. Path separators go too — the bytes
 * never touch a filesystem so there is no traversal target by construction, but
 * a name is not the place to carry a path.
 */
export function sanitizeFilename(raw: string | null | undefined): string {
  const cleaned = (raw ?? "")
    .replace(CONTROL_AND_BIDI, "")
    .replace(/[\\/]/g, "_")
    .replace(/\.{2,}/g, ".")
    .trim();

  const capped = cleaned.slice(0, MAX_FILENAME_LENGTH);
  // Never return empty: a blank filename produces a malformed header and an
  // unlabelled download.
  return capped.length > 0 ? capped : "attachment";
}

/**
 * Build a `Content-Disposition` value carrying both forms.
 *
 * The plain `filename=` is ASCII-only for old parsers; `filename*=` carries the
 * real UTF-8 name per RFC 5987. Both are derived from the sanitized name, so
 * neither can inject.
 */
export function contentDisposition(
  disposition: "inline" | "attachment",
  rawFilename: string | null | undefined,
): string {
  const safe = sanitizeFilename(rawFilename);

  // Quote-and-backslash escaped, non-ASCII flattened — this is the fallback,
  // not the source of truth.
  const ascii = safe
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");

  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The full header set for one attachment response.
 *
 * `nosniff` is on EVERY response, not just inline ones, and it is load-bearing
 * rather than hygiene: `mime_type` is attacker-controlled, so without it a
 * browser is free to sniff its way to a more dangerous interpretation than the
 * one we declared.
 *
 * The CSP applies to inline responses, where a rendered document could
 * otherwise reach the network: `sandbox` drops it into an opaque origin with no
 * script execution, and `default-src 'none'` stops it fetching anything at all.
 */
export function buildAttachmentHeaders(params: {
  disposition: "inline" | "attachment";
  contentType: string;
  filename: string;
  contentLength?: number;
}): Headers {
  const headers = new Headers();

  headers.set("Content-Type", params.contentType);
  headers.set("Content-Disposition", contentDisposition(params.disposition, params.filename));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  // Private user content: never in a shared cache (`private`). The viewer's own
  // browser may keep it for 8 hours (P-7, decided 2026-10): reopening is then
  // instant and costs nothing, and a copy on a shared computer lapses within a
  // working day. The server cannot revoke a copy a browser already holds, or a
  // file the user explicitly downloaded — the privacy notes say so.
  headers.set("Cache-Control", "private, max-age=28800");

  if (typeof params.contentLength === "number") {
    headers.set("Content-Length", String(params.contentLength));
  }

  return headers;
}
