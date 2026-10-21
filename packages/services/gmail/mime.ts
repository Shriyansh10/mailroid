/**
 * MIME encoding primitives for outbound mail, and the decoder for inbound
 * headers.
 *
 * Separate from index.ts because every function here is pure and total — a
 * string or a Buffer in, a string out, no I/O, no Gmail, no database. That is
 * what makes the encoding rules testable at all: the alternative is proving
 * base64 line folding by sending real mail and squinting at it in a client.
 *
 * Three standards show up, and they are easy to confuse because they all exist
 * to smuggle non-ASCII through a 7-bit transport:
 *
 *   RFC 2047 — non-ASCII in HEADER VALUES.      `=?UTF-8?B?…?=`
 *   RFC 2231 — non-ASCII in HEADER PARAMETERS.  `filename*=UTF-8''…`
 *   RFC 2045 — base64 for BODY PARTS.           76-char lines
 *
 * A filename needs 2231, a subject needs 2047, and using either in the other's
 * place produces something that looks right in one mail client and garbled in
 * the next.
 */
import { randomBytes } from "node:crypto";

/** Printable ASCII only — the set that needs no encoding at all. */
const IS_PLAIN_ASCII = /^[\x20-\x7E]*$/;

/**
 * RFC 2047 encoded-words are capped at 75 characters INCLUDING the
 * `=?UTF-8?B?` prefix (10) and `?=` suffix (2).
 *
 * That leaves 63 for base64, and base64 emits 4 characters per 3 bytes, so the
 * largest whole-3-byte payload that fits is 45 bytes → 60 characters. Going to
 * 48 bytes would emit 64 and breach the limit.
 */
const MAX_ENCODED_WORD_BYTES = 45;

/**
 * Encode one header value for transport.
 *
 * ASCII passes through untouched, which matters for more than efficiency: an
 * encoded-word is only legal in certain positions, and blanket-encoding a
 * structured header like `To:` would turn valid addresses into an opaque blob
 * that no MTA can route. Callers must only apply this to unstructured values —
 * `Subject` is the one this codebase encodes.
 *
 * Long values are split into several encoded-words joined by CRLF + space.
 * The split is on CODE POINT boundaries, never byte boundaries: each
 * encoded-word must decode independently, and a word cut through the middle of
 * a multi-byte UTF-8 sequence decodes to a replacement character in the middle
 * of the reader's subject line.
 */
export function encodeHeaderValue(value: string): string {
  if (IS_PLAIN_ASCII.test(value)) return value;

  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  // Array.from iterates code points, so a surrogate pair stays intact.
  for (const char of Array.from(value)) {
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (currentBytes + charBytes > MAX_ENCODED_WORD_BYTES && current.length > 0) {
      chunks.push(current.join(""));
      current = [];
      currentBytes = 0;
    }
    current.push(char);
    currentBytes += charBytes;
  }
  if (current.length > 0) chunks.push(current.join(""));

  return chunks
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, "utf-8").toString("base64")}?=`)
    .join("\r\n ");
}

/** `=?charset?encoding?text?=` */
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

/** Decode the `Q` variant: `_` is a space, `=XX` is a hex byte. */
function decodeQ(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "_") {
      bytes.push(0x20);
      continue;
    }
    if (ch === "=" && i + 3 <= text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeBytes(bytes: Buffer, charset: string): string {
  // RFC 2231 permits a language suffix (`UTF-8*en`); TextDecoder does not know
  // about it. Strip before looking the label up.
  const label = charset.toLowerCase().split("*")[0]!;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // An unknown or misspelt charset is common in real mail. UTF-8 is the least
    // wrong guess, and mojibake beats throwing away the header entirely.
    return bytes.toString("utf-8");
  }
}

/**
 * Decode RFC 2047 encoded-words in an inbound header value.
 *
 * NOT the inverse of encodeHeaderValue, and deliberately more permissive than
 * it: we control what we emit, but we receive whatever the sending client
 * produced. `Q` encoding, charsets other than UTF-8, and mixed
 * encoded/unencoded text in one header all appear routinely in real mail.
 *
 * Returns the input unchanged when there is nothing to decode, so it is safe to
 * apply to every header read.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;

  // Whitespace BETWEEN two adjacent encoded-words is a folding artifact and
  // must vanish (RFC 2047 §6.2) — a long subject split across two words would
  // otherwise gain a space in the middle of a word. Whitespace between an
  // encoded-word and ordinary text is real content and is left alone.
  const collapsed = value.replace(/\?=[ \t]*(?:\r?\n[ \t]+)?[ \t]*=\?/g, "?==?");

  ENCODED_WORD.lastIndex = 0;
  return collapsed.replace(ENCODED_WORD, (whole, charset: string, encoding: string, text: string) => {
    try {
      const bytes = encoding.toUpperCase() === "B" ? Buffer.from(text, "base64") : decodeQ(text);
      return decodeBytes(bytes, charset);
    } catch {
      // A malformed encoded-word is left exactly as it arrived. Showing the
      // reader `=?UTF-8?B?bad?=` is worse than showing them the text, but far
      // better than showing them nothing or failing the whole message.
      return whole;
    }
  });
}

/**
 * Strip the characters that make a filename dangerous in a header.
 *
 * Path separators, CR/LF and bidi overrides, matching what the read path does
 * on the way in (attachments/headers.ts). A filename is attacker-influenced on
 * a forward — it came from whoever sent the original message.
 */
export function sanitizeFilename(filename: string): string {
  return (
    Array.from(filename)
      .filter((ch) => {
        const code = ch.codePointAt(0)!;
        if (code <= 0x1f || code === 0x7f) return false;
        // Bidi overrides: the trick that renders `fdp.exe` as `exe.pdf`.
        if (code >= 0x202a && code <= 0x202e) return false;
        if (code >= 0x2066 && code <= 0x2069) return false;
        if (code === 0x200e || code === 0x200f) return false;
        return true;
      })
      .join("")
      .replace(/[/\\]/g, "_")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 200) || "attachment"
  );
}

/**
 * A `Content-Disposition` filename, in both forms.
 *
 * RFC 2231's `filename*=UTF-8''…` is what modern clients read; the plain
 * `filename="…"` beside it is what old ones read. Emitting both is the standard
 * belt-and-braces, and the ASCII form is transliterated rather than encoded —
 * a client that cannot read 2231 also cannot read an encoded-word here.
 */
export function encodeFilenameParams(filename: string): string {
  const safe = sanitizeFilename(filename);
  // Quotes and backslashes would end the quoted-string early.
  const asciiFallback = safe.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const params = [`filename="${asciiFallback}"`];
  if (!IS_PLAIN_ASCII.test(safe)) {
    params.push(`filename*=UTF-8''${encodeRFC2231Value(safe)}`);
  }
  return params.join("; ");
}

/** Percent-encoding for an RFC 2231 parameter value: attribute chars survive. */
function encodeRFC2231Value(value: string): string {
  return Array.from(Buffer.from(value, "utf-8"))
    .map((byte) => {
      const ch = String.fromCharCode(byte);
      return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(ch)
        ? ch
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/** Base64 in 76-character lines, as RFC 2045 requires for a body part. */
export function base64Lines(buffer: Buffer): string {
  const encoded = buffer.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

/**
 * A MIME boundary that cannot appear in the content it delimits.
 *
 * 144 bits of randomness rather than a counter or a timestamp. The failure this
 * avoids is not collision in the abstract — it is that a boundary appearing
 * inside an attachment truncates the message at that point, and the result is a
 * mail that sends successfully and arrives with its contents cut in half.
 *
 * In practice every part below is base64-encoded, whose alphabet excludes `=`
 * in the middle and `_`, so a collision is impossible rather than merely
 * unlikely. The randomness is defence for anyone who later adds a non-encoded
 * part.
 */
export function generateBoundary(): string {
  return `----=_Mailroid_${randomBytes(18).toString("hex")}`;
}

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/**
 * Fixed cost of one attachment part, in bytes, excluding its content.
 *
 * Boundary line, Content-Type, Content-Disposition (both filename forms),
 * Content-Transfer-Encoding, and the blank line. Rounded generously upward —
 * this number exists to keep an estimate on the safe side of Gmail's ceiling,
 * so erring large is the correct direction to err.
 */
const PART_OVERHEAD_BYTES = 220;

/** Flat allowance for To/Cc/Bcc/Subject/In-Reply-To/References and the
 *  multipart Content-Type line. Generous on purpose, same reasoning. */
const TOP_LEVEL_HEADER_BYTES = 2048;

/**
 * Projected size of the finished, encoded MIME message.
 *
 * THE ONE PLACE THIS ARITHMETIC LIVES. Gmail's 25 MB limit is on the ENCODED
 * message, and base64 inflates by 4/3 before line breaks are added — so raw
 * bytes and the limit are in different units and comparing them directly is a
 * bug that only shows up between roughly 19 and 25 MB of input.
 *
 * The upload route, the send path and the compose UI all call this rather than
 * each applying their own fudge factor. Two places disagreeing about a limit is
 * exactly how the read path acquired a dead band where every attachment between
 * 16 and 25 MiB was permanently unfetchable while every test passed.
 */
export function projectEncodedSize(
  attachments: Array<{ content?: Buffer; sizeBytes?: number; filename?: string }>,
  bodyBytes = 0,
): number {
  // The body part is base64-encoded too once the message is multipart, plus a
  // flat allowance for the top-level headers (To/Cc/Subject/References and the
  // multipart Content-Type). Those are small and bounded; the attachments are
  // what actually decide whether a message fits.
  let total = base64Size(bodyBytes) + PART_OVERHEAD_BYTES + TOP_LEVEL_HEADER_BYTES;

  for (const attachment of attachments) {
    const raw = attachment.content?.byteLength ?? attachment.sizeBytes ?? 0;
    total += base64Size(raw) + PART_OVERHEAD_BYTES + (attachment.filename?.length ?? 0) * 2;
  }
  return total;
}

/** base64 length for n bytes, including the CRLF after every 76 characters. */
function base64Size(rawBytes: number): number {
  const encoded = Math.ceil(rawBytes / 3) * 4;
  return encoded + Math.ceil(encoded / 76) * 2;
}
