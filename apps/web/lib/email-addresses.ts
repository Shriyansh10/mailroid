/**
 * Address-list helpers for the recipient chips.
 *
 * SCOPE, deliberately narrow: this is a parser for UI editing, NOT an RFC 5322
 * implementation. It handles what a person types or pastes into a recipient
 * field and what Gmail's own To/Cc headers contain — display names, angle
 * brackets, quoted names with commas in them, and lists separated by commas,
 * semicolons or spaces. Group syntax, parenthesised comments, folded headers
 * and quoted local-parts are explicitly out of scope: the server hands the
 * joined string to Gmail, which is the real parser. Don't grow this file
 * chasing legal-but-never-seen grammar.
 *
 * Recipient lines travel through the whole app as comma-joined strings, which
 * is what an RFC header already is — chips are purely a rendering concern.
 */

/** Shape check only — no MX lookup, no RFC-exhaustive local-part grammar. */
export function isValidAddress(address: string): boolean {
  return /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(address.trim());
}

/**
 * Split a header value (or something a user typed/pasted) into bare addresses.
 *
 * Separators inside quotes or angle brackets don't count, which is the only
 * genuinely fiddly part: `"Agarwal, Shriyansh" <a@b.com>` is ONE recipient,
 * and splitting naively on commas would silently turn it into two bogus ones.
 *
 * Whitespace separates too, but only in the second pass — see splitBareRun.
 */
export function parseAddressList(value: string | undefined | null): string[] {
  if (!value) return [];

  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngles = false;

  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === "<") {
      inAngles = true;
      current += char;
    } else if (char === ">") {
      inAngles = false;
      current += char;
    } else if ((char === "," || char === ";" || char === "\n") && !inQuotes && !inAngles) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);

  return parts.flatMap(splitBareRun).map(extractAddress).filter(Boolean);
}

/**
 * Second pass: split a comma-delimited part on whitespace.
 *
 * A space means two different things depending on context. In
 * `a@b.com c@d.com` it separates two recipients; in
 * `Shriyansh Agarwal <a@b.com>` it sits inside one recipient's name. An
 * angle group is what tells them apart, so each `…<addr>` is taken whole and
 * only what trails the last one is split on whitespace. That keeps
 * `Bob <b@x.com> c@d.com` as two recipients rather than dropping the second,
 * which is what happens if the whole part is handed to extractAddress.
 *
 * The one thing this gets "wrong" is a bare name with no address —
 * `Shriyansh Agarwal` becomes two invalid chips rather than one. Both render
 * as unsendable either way, so nothing is lost but tidiness.
 */
function splitBareRun(part: string): string[] {
  if (!part.includes("<")) return part.split(/\s+/);

  const out: string[] = [];
  const groupRe = /<[^>]*>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = groupRe.exec(part)) !== null) {
    const end = match.index + match[0].length;
    out.push(part.slice(cursor, end)); // the display name plus its <addr>
    cursor = end;
  }

  const tail = part.slice(cursor).trim();
  if (tail) out.push(...tail.split(/\s+/));
  return out;
}

/**
 * "Display Name <addr@x.com>" → "addr@x.com". Mirrors extractAddress in
 * packages/services/gmail/index.ts and parseSender in thread-message-list.tsx
 * so an address means the same thing on both sides of the wire.
 */
function extractAddress(part: string): string {
  const match = part.match(/<([^>]+)>/);
  return (match ? match[1]! : part).replace(/"/g, "").trim();
}

/** Back to the comma-joined form the send/draft mutations expect. */
export function joinAddresses(addresses: string[]): string {
  return addresses.join(", ");
}

/** Case-insensitive, first occurrence wins, silent. */
export function dedupeAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/** Case-insensitive set subtraction — used to drop the sender and yourself. */
export function removeAddresses(addresses: string[], exclude: string[]): string[] {
  const excluded = new Set(
    exclude.filter(Boolean).map((address) => address.toLowerCase()),
  );
  return addresses.filter((address) => !excluded.has(address.toLowerCase()));
}
