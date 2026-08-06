// ── Deterministic signature append ──────────────────────────────────────
//
// The system prompt tells the model never to write its own sign-off, but
// "don't" is not "can't" — a model that ignores the instruction produces a
// doubled closing ("Best regards, John ... Best regards, John") once the
// real signature is appended underneath. stripTrailingSignOff catches the
// model's own attempt before appending, so the result always has exactly
// one signature: the user's real one, never a placeholder.

export interface StoredSignature {
  enabled: boolean;
  text: string;
}

// Matches a bare closing line ("Best regards,", "Sincerely", "Thanks,") only
// — it doesn't need to parse arbitrary prose, just the small, predictable set
// of phrases a model reaches for when told to sign an email off.
const CLOSING_LINE_RE = /^(best|regards|best regards|sincerely|thanks|thank you|cheers|warmly|warm regards|kind regards)[\s,]*$/i;

// A short, capitalized-looking line with no punctuation immediately after a
// closing phrase reads as a name/placeholder ("John", "[Your Name]") rather
// than a continuation of the message body.
const NAME_LIKE_LINE_RE = /^[\s\S]{0,60}$/;

/**
 * Strips a trailing model-written sign-off (closing phrase, optionally
 * followed by a bare name/placeholder line) from the end of a body. Only
 * touches the last 1-2 non-empty lines — it is intentionally narrow, not a
 * general "detect a signature" parser.
 */
export function stripTrailingSignOff(body: string): string {
  const lines = body.split("\n");

  // Drop trailing blank lines first so "last line" means the last content.
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) return body.trim();

  let end = lines.length;

  // A name/placeholder line directly under a closing phrase.
  const last = lines[end - 1]!.trim();
  const secondLast = end >= 2 ? lines[end - 2]!.trim() : "";

  if (CLOSING_LINE_RE.test(secondLast) && NAME_LIKE_LINE_RE.test(last) && last.length > 0) {
    end -= 2;
  } else if (CLOSING_LINE_RE.test(last)) {
    end -= 1;
  } else {
    return body.trim();
  }

  while (end > 0 && lines[end - 1]!.trim() === "") end--;

  return lines.slice(0, end).join("\n").trim();
}

/**
 * Appends the user's stored signature to a generated body, defensively
 * stripping anything that looks like the model's own attempt at a sign-off
 * first. A no-op when the signature is disabled/empty.
 */
export function appendSignature(body: string, signature: StoredSignature | undefined): string {
  if (!signature?.enabled || !signature.text.trim()) return body;

  const withoutModelSignOff = stripTrailingSignOff(body);
  return `${withoutModelSignOff}\n\n${signature.text.trim()}`;
}
