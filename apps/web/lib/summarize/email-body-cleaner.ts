// ── Email body cleaning ─────────────────────────────────────────────────
//
// Strips quoted reply history and client signature noise from a single
// message body. Pure and dependency-free on purpose: this is the file that
// grows forever as new mail clients turn up, so it stays isolated from
// thread assembly (thread-source.ts) and testable on its own.
//
// Why this exists at all: summarizing a thread means concatenating every
// message, and every reply already contains a copy of the one before it.
// Left alone, a 5-message thread sends message 1 to the model five times —
// it burns the char budget on duplicates and skews the summary toward
// whatever was said first.

/**
 * Markers that begin quoted history. Everything from the earliest match
 * onward is dropped.
 *
 * Named rather than inlined so a future miss is one row to add, and so the
 * scratch check can report which rule fired.
 */
export const QUOTE_MARKERS: { name: string; pattern: RegExp }[] = [
  // Gmail, and exactly what this app's own replies emit — see
  // renderQuotedText in components/inbox/inline-reply-box.tsx.
  { name: "gmail-on-wrote", pattern: /^On .*wrote:\s*$/m },
  // Some clients wrap "On <date>, <name>" across two lines.
  { name: "gmail-on-wrote-wrapped", pattern: /^On .*\r?\n.*wrote:\s*$/m },
  // Reply quotes only. "Forwarded message" deliberately does NOT belong
  // here — see FORWARD_MARKERS.
  { name: "original-message", pattern: /^\s*-{2,}\s*Original Message\s*-{2,}/im },
  // Outlook's horizontal rule above quoted history.
  { name: "outlook-rule", pattern: /^_{5,}\s*$/m },
  // The Outlook header block. Matched as a BLOCK (From: followed by at
  // least one more header line) so a sentence that merely starts with
  // "From: " doesn't truncate a legitimate message.
  {
    name: "outlook-header-block",
    pattern: /^\s*From:.*(?:\r?\n\s*(?:Sent|To|Cc|Subject|Date):.*)+/im,
  },
];

/**
 * Markers that begin FORWARDED content, which must be kept.
 *
 * The distinction that matters: a reply quote is a copy of a message that
 * already appears elsewhere in the thread, so dropping it removes a
 * duplicate. Forwarded content appears nowhere else — it IS the message.
 * Cutting there leaves only the sender's covering note ("doing test") and
 * the summary becomes "this is a forward of a previous conversation",
 * which is exactly what the reader could already see.
 *
 * Note the forwarded block carries its own From/Date/Subject headers, which
 * would otherwise trip outlook-header-block above — so when a forward is
 * detected, no cutting runs at all.
 */
export const FORWARD_MARKERS: { name: string; pattern: RegExp }[] = [
  { name: "gmail-forwarded", pattern: /^\s*-{2,}\s*Forwarded message\s*-{2,}/im },
  { name: "apple-forwarded", pattern: /^\s*Begin forwarded message:/im },
  { name: "outlook-forwarded", pattern: /^\s*-{2,}\s*Original Message\s*-{2,}\s*\r?\n\s*From:.*\r?\n\s*Sent:/im },
];

/**
 * Trailing noise that carries no information. Cut from the earliest match,
 * same as quotes — these always sit at the end of a message.
 */
export const SIGNATURE_MARKERS: { name: string; pattern: RegExp }[] = [
  // RFC 3676 signature delimiter: "-- " alone on a line.
  { name: "sig-delimiter", pattern: /^--\s*$/m },
  { name: "sent-from-device", pattern: /^\s*Sent from my \w+.*$/im },
  { name: "get-outlook", pattern: /^\s*Get Outlook for \w+.*$/im },
];

/** Earliest match index across a marker set, or -1 when none match. */
function earliestMatch(
  text: string,
  markers: { name: string; pattern: RegExp }[],
): { index: number; name: string } | null {
  let best: { index: number; name: string } | null = null;
  for (const { name, pattern } of markers) {
    const m = pattern.exec(text);
    if (m && m.index >= 0 && (best === null || m.index < best.index)) {
      best = { index: m.index, name };
    }
  }
  return best;
}

export interface CleanResult {
  text: string;
  /** Which rule cut the body, for logging and the scratch check. */
  cutBy: string | null;
  /** True when forwarded content was detected and deliberately kept whole. */
  isForward: boolean;
}

/**
 * Removes quoted history, quote-prefixed lines and signature noise.
 *
 * Markers are evaluated for the EARLIEST match rather than applied in
 * sequence: a message can contain several kinds of marker, and cutting at
 * the first one found by iteration order would leave whatever precedes the
 * winner in the output.
 *
 * A forward is the exception — nothing is cut. See FORWARD_MARKERS.
 */
export function cleanEmailBody(body: string | null | undefined): CleanResult {
  if (!body) return { text: "", cutBy: null, isForward: false };

  let text = body.replace(/\r\n/g, "\n");

  // Forward check first, and it short-circuits every cut: the forwarded
  // block's own From/Date/Subject headers would otherwise be mistaken for
  // an Outlook reply-quote header block, and a "-- " or "Sent from my
  // iPhone" inside the forwarded body would truncate the payload.
  const forward = earliestMatch(text, FORWARD_MARKERS);
  if (forward) {
    return { text: normalizeWhitespace(text), cutBy: null, isForward: true };
  }

  const quote = earliestMatch(text, QUOTE_MARKERS);
  if (quote) text = text.slice(0, quote.index);

  const sig = earliestMatch(text, SIGNATURE_MARKERS);
  if (sig) text = text.slice(0, sig.index);

  return {
    text: normalizeWhitespace(text),
    cutBy: quote?.name ?? sig?.name ?? null,
    isForward: false,
  };
}

/** Drops surviving quote-prefixed lines and invisible-character litter. */
function normalizeWhitespace(text: string): string {
  return text
    // Quote-prefixed lines ("> old text") that survived, e.g. when the
    // client omitted an attribution line entirely.
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    // Zero-width and non-breaking space litter from HTML-to-text. Written
    // as escapes, not literals — these are invisible in an editor.
    // Alternation rather than a character class: ZWJ inside a class trips
    // no-misleading-character-class, since it can join adjacent codepoints.
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
    .replace(/\u00A0/g, " ")
    // Collapse runs of blank lines left behind by the cuts above.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Convenience wrapper when the caller only wants the text. */
export function stripQuotedHistory(body: string | null | undefined): string {
  return cleanEmailBody(body).text;
}
