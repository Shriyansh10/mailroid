import { createHash } from "node:crypto";

/**
 * Mailbox identity for logs, without the mailbox address.
 *
 * THE DEFAULT POSITION IS: log `tenantId`, not an address. The internal id is
 * the join key that makes attribution work and is meaningless outside our own
 * database. This function is for the narrow case where the address is genuinely
 * the correlation key — a Pub/Sub push that has not resolved to a tenant yet,
 * for instance, where `tenantId` does not exist and "which mailbox" is the whole
 * question.
 *
 * A keyed digest, not a plain hash. Mailbox addresses are low-entropy and
 * enumerable: an unkeyed sha256 of "someone@gmail.com" is a rainbow-table lookup
 * away from being the address again, so it would be obfuscation rather than
 * redaction.
 *
 * THE SECRET MUST BE STABLE ACROSS RESTARTS. A per-process random salt would
 * make every restart produce different digests for the same mailbox, which
 * destroys exactly the correlation the digest exists to provide — and this
 * system restarts constantly under `tsx watch`.
 *
 * With `LOG_HASH_SECRET` unset this returns a fixed marker rather than an
 * unkeyed hash or the address itself. Degrading to "less correlation" is
 * correct; degrading to "a leak" is not.
 */

const NO_SECRET = "<no-hash-secret>";
const DIGEST_LENGTH = 12;

let warned = false;

export function hashMailbox(
  email: string | null | undefined,
  secret: string | undefined = process.env.LOG_HASH_SECRET,
): string {
  if (!email) return "<none>";

  if (!secret || secret.length === 0) {
    if (!warned) {
      warned = true;
      // console, not logger: this module is imported BY the logger's consumers
      // and must not create an import cycle. Once per process, never per call.
      console.warn(
        "[LOGGER] LOG_HASH_SECRET is unset — mailbox digests are disabled and " +
          "logs will not correlate by mailbox. Set it to any long random string, " +
          "the same value for the lifetime of an environment.",
      );
    }
    return NO_SECRET;
  }

  // Normalised first: Gmail treats the local part case-insensitively, and two
  // digests for one mailbox is the same failure as no digest at all.
  const normalised = email.trim().toLowerCase();

  return createHash("sha256")
    .update(`${normalised}${secret}`)
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
}

/**
 * The same digest, for a header value that may carry several recipients.
 *
 * `to`, `cc` and `bcc` arrive as one raw header string — `"Ana <a@x.com>,
 * b@y.com"` — so hashing the whole string would produce a digest that changes
 * whenever the display name or the ordering does, which is no correlation at
 * all. Each address is extracted and digested on its own.
 *
 * The extraction is deliberately crude and self-contained: `@repo/logger` sits
 * beneath the services, so it cannot reach for `parseAddressList` in
 * `@repo/services/scheduling` without inverting the dependency. Getting this
 * slightly wrong costs a mismatched digest; importing upwards costs a cycle.
 */
export function hashMailboxList(
  value: string | null | undefined,
  secret: string | undefined = process.env.LOG_HASH_SECRET,
): string {
  if (!value || value.trim().length === 0) return "<none>";

  return value
    .split(",")
    .map((part) => {
      const angled = part.match(/<([^>]*)>/);
      return hashMailbox((angled?.[1] ?? part).trim(), secret);
    })
    .filter((digest) => digest !== "<none>")
    .join(",");
}

/**
 * Truncate anything that might carry mail content before it reaches a log.
 *
 * For the cases where a preview is genuinely useful — an unparseable webhook
 * body, say — and the alternative is dumping the whole payload. Bounded hard,
 * because "just the first bit" is how a 200 KB message body ends up on disk.
 */
export function preview(value: unknown, maxLength = 120): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
