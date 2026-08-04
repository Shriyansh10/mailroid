import { createHash } from "node:crypto";

/**
 * Normalisation for the RFC822 `Message-ID` header.
 *
 * One function, used by every write and every read, because the organiser and
 * the guest normalise *independently* — they are different users, different
 * sync runs, often different machines. Any asymmetry between two call sites
 * shows up as "the guest just can't see the meeting", with no error anywhere.
 *
 * The rules are deliberately minimal:
 *
 *   - strip the surrounding angle brackets, which are message-syntax rather
 *     than part of the identifier
 *   - trim surrounding whitespace, including the folding whitespace a long
 *     header line can carry
 *   - change nothing else
 *
 * In particular this does NOT lowercase. RFC 5322 makes the local part of an
 * addr-spec case-sensitive, so `<AbC@example.com>` and `<abc@example.com>` are
 * formally different ids. Gmail's own are lowercase, but a message from any
 * other MTA need not be, and silently folding case would be a guess about
 * someone else's identifier.
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let value = raw.trim();
  // A header can fold across lines; collapse that before anything else.
  value = value.replace(/\s+/g, " ").trim();

  // Some senders emit several ids in one header. The first is the message's
  // own; anything after it is noise we must not match on.
  const firstAngle = /<([^>]+)>/.exec(value);
  if (firstAngle) {
    value = firstAngle[1]!.trim();
  } else {
    // No non-empty bracketed id. Strip any stray brackets so an empty `<>`
    // becomes empty rather than surviving as the literal string "<>" — which
    // would be stored as an id and could then match another message's "<>".
    value = value.replace(/[<>]/g, "").trim();
  }

  if (!value) return null;

  // Google caps an extendedProperties value at 1024 chars. RFC 5322 caps a
  // header line at 998, so this is effectively unreachable — but a truncated
  // id would never match anything while looking perfectly fine in the
  // database, so it is rejected rather than shortened.
  if (value.length > 1024) return null;

  return value;
}

/**
 * A Message-ID rendered safe for use as a Google Calendar
 * `sharedExtendedProperty` VALUE.
 *
 * Confirmed by `pnpm admin calendar:probe-shared-props`: Google's
 * `sharedExtendedProperty` query filter reliably matches a plain synthetic
 * value, but fails to match a realistic Gmail Message-ID once it contains `+`
 * and `=` — which most do (they're loosely base64-flavoured). The property
 * still WRITES and READS correctly either way (confirmed by the same probe);
 * only the FILTERED search silently fails to match, which is exactly the
 * failure mode that makes a guest see nothing without any error anywhere.
 *
 * SHA-256, hex, truncated to 32 chars (128 bits) — fixed alphabet (0-9a-f),
 * nothing that can trip a query-string parser, and collision-safe enough that
 * two different threads (anyone's, not just this app's) landing on the same
 * value is not a practical concern. One-way is fine: this value only ever
 * needs to be COMPARED, never read back — the real Message-ID is already
 * stored in our own database, so nothing is lost by not being able to reverse
 * this. It also means the raw email identifier never leaves our database for
 * Google's metadata store, which is a reasonable thing to avoid regardless of
 * the bug above.
 */
export function hashMessageIdForCalendar(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex").slice(0, 32);
}
