/**
 * Limits and type rules for OUTGOING attachments.
 *
 * Shared deliberately between the upload route, the send path and the compose
 * UI. Every one of these numbers exists in exactly one place, because the
 * alternative has already cost this codebase once: the read path shipped a
 * 25 MiB size gate against a 64 MiB byte budget charged at 4x, and the
 * disagreement made every attachment between 16 and 25 MiB permanently
 * undownloadable while 155 tests passed. Two limits stated in different units,
 * each correct alone.
 *
 * There are TWO ceilings here and they are not interchangeable:
 *
 *   MAX_TOTAL_RAW_BYTES         25 MiB   the FILES, Gmail's user-facing rule
 *   GMAIL_API_MAX_MESSAGE_BYTES 35 MiB   the ENCODED MESSAGE, the API contract
 *
 * A set of files is checked against the first; the assembled message against
 * the second. Collapsing them into one number is precisely the mistake that
 * capped sending at ~18 MB of files — see GMAIL_API_MAX_MESSAGE_BYTES.
 */
import { projectEncodedSize } from "./mime.ts";

/**
 * The transport ceiling: the largest ENCODED message the Gmail API will accept.
 *
 * 36,700,160 bytes — exactly 35 MiB — read from Google's own machine-readable
 * API contract rather than from prose. In the Gmail v1 discovery document
 * (https://gmail.googleapis.com/$discovery/rest?version=v1) every endpoint this
 * codebase sends through declares the same `mediaUpload.maxSize`:
 *
 *   users.messages.send    36700160   ("message/*")
 *   users.drafts.create    36700160
 *   users.drafts.update    36700160
 *   users.drafts.send      36700160
 *
 * (users.messages.insert and .import declare 157286400, but neither sends
 * anything — do not reach for that number.)
 *
 * THIS NUMBER IS NOT 25 MB, AND THE DIFFERENCE IS THE BUG THIS FILE ONCE HAD.
 * "25 MB" is Gmail's USER-FACING allowance for the FILES a person attaches
 * (MAX_TOTAL_RAW_BYTES below). This constant is the ceiling on the whole
 * message AFTER base64. Applying the user-facing number to the encoded message
 * conflates two quantities that differ by ~37%, and it rejected sets that Gmail
 * itself accepts: 24.8 MB of files projects to ~33.9 MB encoded, which is over
 * a 25 MB ceiling and comfortably under the real one. The file was scrupulous
 * about never comparing raw bytes to the limit, and then compared them to the
 * wrong limit.
 *
 * Only reachable via the /upload/ endpoint, which send-raw.ts uses. The
 * non-upload JSON endpoint caps far lower; see the header there.
 */
export const GMAIL_API_MAX_MESSAGE_BYTES = 36_700_160;

/**
 * What a person may attach: 25 MB of FILES, matching Gmail's own composer.
 *
 * Written down rather than derived, because it is a PRODUCT decision and not an
 * arithmetic one. Gmail tells users "25 MB"; Mailroid promising some other
 * number — even a larger one derived from the transport — would make the two
 * clients disagree about the same mailbox, and the user believes Gmail.
 *
 * Its FEASIBILITY is not taken on trust. attachment-limits.test.ts asserts that
 * a full 25 MB of files still projects under GMAIL_API_MAX_MESSAGE_BYTES with
 * real headroom, so if anyone widens the per-part overhead in mime.ts far enough
 * to eat that margin, the suite fails instead of the send doing so. That test is
 * what replaces the old inversion: the anti-drift property is kept, while the
 * advertised limit stays a number the user recognises.
 *
 * Deliberately MiB (26,214,400), the more generous of the two readings of
 * "25 MB", so Mailroid never refuses a set Gmail would have taken. It is also
 * the unit `mb()` below formats in, so the number shown to the user is the
 * number enforced.
 */
export const MAX_TOTAL_RAW_BYTES = 25 * 1024 * 1024;

/**
 * The ceiling the upload route enforces on the whole multipart body.
 *
 * Deliberately a little larger than MAX_TOTAL_RAW_BYTES — the body also carries
 * the recipient, subject, message text, field names and boundaries — but still
 * far below anything that threatens the container. It is the CHEAPEST place a
 * too-large request can be refused: past this point the bytes are resident.
 */
export const MAX_UPLOAD_BYTES = MAX_TOTAL_RAW_BYTES + 1024 * 1024;

/** More than this many files on one message is a mistake, not a use case. */
export const MAX_ATTACHMENT_COUNT = 25;

/**
 * Extensions Gmail refuses outright, whatever the declared MIME type.
 *
 * Checked here so the user gets a sentence they can act on instead of a raw
 * Gmail 400 surfaced as "send failed". This is NOT a security control — the
 * bytes are opaque to us either way, and Mailroid never inspects them — it is
 * an error-message control.
 */
const BLOCKED_EXTENSIONS = new Set([
  "ade", "adp", "apk", "appx", "appxbundle", "bat", "cab", "chm", "cmd", "com",
  "cpl", "dll", "dmg", "ex", "ex_", "exe", "hta", "ins", "isp", "iso", "jar",
  "js", "jse", "lib", "lnk", "mde", "msc", "msi", "msix", "msixbundle", "msp",
  "mst", "nsh", "pif", "ps1", "scr", "sct", "shb", "sys", "vb", "vbe", "vbs",
  "vxd", "wsc", "wsf", "wsh",
]);

/** Archive types Gmail inspects the CONTENTS of, and will reject if they carry
 *  a blocked type — including when password-protected, which is why we cannot
 *  pre-check them ourselves. */
const ARCHIVE_EXTENSIONS = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2"]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase().trim();
}

export interface OutgoingAttachmentMeta {
  filename: string;
  sizeBytes: number;
}

export type AttachmentValidation =
  | { ok: true }
  | { ok: false; reason: string; code: "count" | "type" | "size" | "empty" };

/**
 * Validate a set of outgoing attachments BEFORE any Gmail call.
 *
 * Returns a reason written for a person. "Send failed" tells a user nothing
 * they can act on; "These attachments total 31.0 MB, and Gmail allows up to
 * 25.0 MB" tells them what to remove.
 *
 * Validates the SUM, never each file alone: three 10 MB files each pass an
 * individual check and together exceed the ceiling.
 *
 * Callers must treat a false verdict as BLOCKING, not advisory. The compose UI
 * rendering this reason while leaving Send enabled is the exact state this
 * function exists to prevent, and it shipped once: the user was told the set was
 * invalid, the chips looked normal, and Send stayed live, so nothing on screen
 * said whether the mail would go.
 */
export function validateOutgoingAttachments(
  attachments: OutgoingAttachmentMeta[],
  bodyBytes = 0,
): AttachmentValidation {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    return {
      ok: false,
      code: "count",
      reason: `You can attach up to ${MAX_ATTACHMENT_COUNT} files to one message; this has ${attachments.length}.`,
    };
  }

  for (const attachment of attachments) {
    if (attachment.sizeBytes <= 0) {
      return {
        ok: false,
        code: "empty",
        reason: `"${attachment.filename}" is empty, so there is nothing to attach.`,
      };
    }

    const ext = extensionOf(attachment.filename);
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        code: "type",
        reason:
          `Gmail will not send .${ext} files, so "${attachment.filename}" cannot be attached. ` +
          `Putting it in a zip does not help — Gmail looks inside archives too. ` +
          `Sharing it through Drive or a link is the usual way round this.`,
      };
    }
  }

  // RULE 1 — the files themselves, against Gmail's user-facing allowance. This
  // is the rule essentially every rejection hits, and it is stated in the unit
  // the user is holding: what they attached, versus what they may attach.
  // Nothing here mentions encoding, because from the user's side the message
  // text is not what put them over and telling them about base64 would be
  // explaining our arithmetic instead of their problem.
  const totalRaw = attachments.reduce((sum, a) => sum + a.sizeBytes, 0);

  if (totalRaw > MAX_TOTAL_RAW_BYTES) {
    const [total, allowed] = mbPair(totalRaw, MAX_TOTAL_RAW_BYTES);
    return {
      ok: false,
      code: "size",
      reason:
        `These attachments total ${total}, and Gmail allows up to ${allowed} of attachments ` +
        `per email. Mailroid does not turn large attachments into Google Drive links, so ` +
        `remove or shrink one to send this message.`,
    };
  }

  // RULE 2 — the assembled message, against the transport ceiling. Rule 1
  // passing does not imply this one: base64 inflates the files by ~37% and the
  // body is encoded alongside them, so a permitted 25 MB of attachments plus a
  // very long quoted forward can still exceed what Gmail will accept.
  //
  // Reachable only through the body, which is why the sentence blames the body.
  // Attachments alone cannot trigger it — the test suite pins that, because a
  // message telling someone to shorten their text when the real problem is a
  // file would be worse than no message at all.
  const projected = projectEncodedSize(attachments, bodyBytes);

  if (projected > GMAIL_API_MAX_MESSAGE_BYTES) {
    const [size, ceiling] = mbPair(projected, GMAIL_API_MAX_MESSAGE_BYTES);
    return {
      ok: false,
      code: "size",
      reason:
        `With its text included, this email comes to about ${size} once encoded for ` +
        `sending — over the ${ceiling} Gmail accepts in one message. ` +
        `The attachments (${mb(totalRaw)}) are within the ${mb(MAX_TOTAL_RAW_BYTES)} limit, so ` +
        `shortening the message — the quoted history especially — will fix it.`,
    };
  }

  return { ok: true };
}

/**
 * Does this file need a warning, without being refused?
 *
 * An archive may contain something Gmail blocks, and we cannot know which —
 * Mailroid never opens an archive, and Gmail rejects password-protected ones it
 * cannot read either. Saying so up front beats a mystery bounce.
 */
export function isUninspectableArchive(filename: string): boolean {
  return ARCHIVE_EXTENSIONS.has(extensionOf(filename));
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Format an over-limit size and the limit it breached so the two cannot read as
 * the same number.
 *
 * `mb()` rounds to one decimal, so a set one byte over the cap rendered as
 * "These attachments total 25.0 MB, and Gmail allows up to 25.0 MB" — a
 * sentence that states a contradiction and leaves the user with nothing to act
 * on, which is the one thing every message in this file is supposed to avoid.
 * Widen the precision until they differ; drop to bytes if even that is not
 * enough, because at that point bytes are the only honest unit left.
 */
function mbPair(actual: number, limit: number): [actual: string, limit: string] {
  for (const places of [1, 2, 3]) {
    const a = (actual / 1024 / 1024).toFixed(places);
    const l = (limit / 1024 / 1024).toFixed(places);
    if (a !== l) return [`${a} MB`, `${l} MB`];
  }
  return [`${actual.toLocaleString("en-US")} bytes`, `${limit.toLocaleString("en-US")} bytes`];
}
