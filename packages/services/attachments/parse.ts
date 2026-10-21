import type { AttachmentMeta } from "./types.ts";

/** The shape this walker needs from a Gmail MIME part. Structural on purpose:
 *  `MessagePart` lives in gmail/index.ts, and importing it here would make the
 *  parser depend on the whole Gmail service just to read five fields. */
export interface ParsablePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  headers?: Array<{ name?: string; value?: string }>;
  parts?: ParsablePart[];
}

function header(part: ParsablePart, name: string): string {
  const h = part.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

/**
 * Walk a Gmail payload and return every attachment part.
 *
 * A part counts as an attachment when it has a non-empty `filename` **or** a
 * `body.attachmentId`. Either alone is insufficient: an inline image
 * referenced by `cid:` often has an attachmentId and an empty filename, and
 * some senders emit a named part with the data inline. `countAttachments`
 * historically tested filename only, which is why inline signature images have
 * always inflated the count.
 *
 * NEVER DOWNLOADS. The pipeline is Gmail → mail sync → metadata → Postgres; the
 * bytes stay in Gmail until a user actually asks for one.
 */
export function extractAttachments(payload: ParsablePart | undefined): AttachmentMeta[] {
  const out: AttachmentMeta[] = [];
  if (!payload) return out;

  const walk = (part: ParsablePart, fallbackId: string) => {
    const attachmentId = part.body?.attachmentId ?? "";
    const filename = part.filename ?? "";
    const isAttachment = filename.length > 0 || attachmentId.length > 0;

    // A container (multipart/*) is never itself an attachment, even though an
    // attached .eml carries both a filename and sub-parts. Recurse first, then
    // decide, so the nested parts are not lost.
    const isContainer = (part.mimeType ?? "").startsWith("multipart/");

    if (isAttachment && !isContainer) {
      const disposition = header(part, "Content-Disposition").toLowerCase().trim();
      const contentId = header(part, "Content-ID").replace(/^<|>$/g, "");

      out.push({
        // partId is absent on the root part and on some malformed messages.
        // Falling back to the tree position keeps the (message, part) unique
        // index satisfiable rather than collapsing every unlabelled part onto
        // one row — which would silently drop attachments.
        partId: part.partId && part.partId.length > 0 ? part.partId : fallbackId,
        filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        sizeBytes: part.body?.size ?? 0,
        gmailAttachmentId: attachmentId,
        /**
         * Content-Disposition decides this, and a Content-ID on its own does
         * NOT mean inline.
         *
         * That distinction is the whole bug this rule was rewritten for.
         * Gmail's own composer stamps `Content-ID: <f_xxxx>` on EVERY
         * attachment it uploads, ordinary documents included — so treating a
         * bare Content-ID as "inline" classified every attachment on every
         * Gmail-composed message as body furniture, the chip row filtered all
         * of them out, and a mail with sixteen attachments rendered as a mail
         * with none. Empty is indistinguishable from "no attachments" in the
         * UI, so it failed silently.
         *
         * The remaining Content-ID clause is deliberately narrow: no
         * disposition at all AND no filename. A part nobody named, carrying an
         * id for something else to reference, is an embedded resource. A part
         * with a filename is a document unless it says otherwise.
         */
        isInline:
          disposition.startsWith("inline") ||
          (disposition.length === 0 && contentId.length > 0 && filename.length === 0),
        contentId: contentId.length > 0 ? contentId : null,
      });
    }

    part.parts?.forEach((child, i) => walk(child, `${fallbackId}.${i}`));
  };

  walk(payload, "0");
  return out;
}

/**
 * Count of attachments a user would actually see as documents.
 *
 * Inline parts are excluded, which is the difference from the old
 * filename-only count: a message whose only "attachment" is the sender's
 * signature logo has zero attachments as far as the reader is concerned, and
 * telling them otherwise — in a forward disclosure, say — is a lie about their
 * own mail.
 */
export function countVisibleAttachments(payload: ParsablePart | undefined): number {
  return extractAttachments(payload).filter((a) => !a.isInline).length;
}
