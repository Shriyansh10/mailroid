/**
 * The original message's attachments, carried onto a forward — or the forward
 * does not happen.
 *
 * THE INVARIANT: a forward never leaves without every file the approval card
 * promised, unless the sender explicitly chose to forward without them. This
 * replaces a fallback that sent anyway with a bracketed "could not be forwarded"
 * note, and a quieter hole beside it: for mail whose manifest was never stored,
 * the carry step found zero rows, carried nothing, and sent with no note at all.
 *
 * ONE DEFINITION OF "FORWARDABLE". The expected set is the live payload's
 * non-inline parts — exactly what `countVisibleAttachments` counts for the
 * approval card, and what the manifest is written from. Expected and carried
 * are compared by `partId`, never by count, so an inline `cid:` image can
 * neither satisfy nor fail the check.
 *
 * EVERYTHING HERE RUNS BEFORE `send`. A thrown ForwardAttachmentsUnavailableError
 * therefore means nothing went out, which is the only reason the UI may offer a
 * one-click "Forward without attachments" on it.
 */
import { FORWARD_ATTACHMENTS_UNAVAILABLE, validateOutgoingAttachments } from "./attachment-limits.ts";
import type { OutgoingAttachment } from "./mime.ts";
import { getAttachmentBytes } from "../attachments/index.ts";
import { listMessageAttachments, replaceAttachmentManifest } from "../attachments/store.ts";
import type { AttachmentMeta } from "../attachments/types.ts";

export { FORWARD_ATTACHMENTS_UNAVAILABLE };

/**
 * The original's files cannot all be carried, and nothing was sent.
 *
 * `code` is what the tRPC and multipart responses key on — never the message,
 * which is prose for the user and free to change.
 */
export class ForwardAttachmentsUnavailableError extends Error {
  readonly code = FORWARD_ATTACHMENTS_UNAVAILABLE;
  constructor(
    readonly reason: "missing" | "too_large",
    /** Files that could not be carried, by name where the name is known. */
    readonly filenames: string[],
    detail?: string,
  ) {
    super(
      reason === "too_large"
        ? `${detail ?? "The original's attachments are too large to forward."} Nothing was sent.`
        : `${describeMissing(filenames)} on the original ${filenames.length === 1 ? "is" : "are"} no longer available, so nothing was sent.`,
    );
    this.name = "ForwardAttachmentsUnavailableError";
  }
}

function describeMissing(filenames: string[]): string {
  const named = filenames.filter((f) => f.trim().length > 0);
  const unnamed = filenames.length - named.length;
  const parts = named.map((f) => `"${f}"`);
  if (unnamed > 0) parts.push(`${unnamed} file${unnamed === 1 ? "" : "s"}`);
  if (parts.length <= 1) return parts[0] ?? "1 file";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The parts a forward promises to carry: the payload's non-inline parts.
 *
 * ONE function, used by both the approval card (via resolveForwardTarget) and
 * the carry step, so the card can never name a different set of files than
 * the forward actually tries to send.
 */
export function forwardableParts(parsed: AttachmentMeta[]): AttachmentMeta[] {
  return parsed.filter((part) => !part.isInline);
}

/**
 * The approval card's text for a forward — the last thing the user reads
 * before real mail leaves. It NAMES the original's files rather than counting
 * them ("contract.pdf" versus "1 attachment" is the difference between
 * knowingly forwarding a contract and doing it by accident), and says plainly
 * when they will NOT go.
 */
export function describeForwardPreview(params: {
  to: string;
  subject: string;
  attachmentNames: string[];
  omitOriginalAttachments?: boolean;
}): string {
  const lines = [`To: ${params.to}`, `Subject: ${params.subject}`];
  const count = params.attachmentNames.length;
  if (count > 0) {
    const names = params.attachmentNames.join(", ");
    lines.push(
      params.omitOriginalAttachments === true
        ? `The original's ${count} attachment${count === 1 ? "" : "s"} will NOT be included: ${names}`
        : `Includes from the original: ${names}`,
    );
  }
  return lines.join("\n");
}

export interface ForwardCarryDeps {
  listMessageAttachments: typeof listMessageAttachments;
  replaceAttachmentManifest: typeof replaceAttachmentManifest;
  getAttachmentBytes: typeof getAttachmentBytes;
}

const defaultDeps: ForwardCarryDeps = {
  listMessageAttachments,
  replaceAttachmentManifest,
  getAttachmentBytes,
};

/**
 * Read back every forwardable part of the original, or throw.
 *
 * `parsed` is the live payload's FULL part list, inline included: if the
 * manifest has to be written here, it must be the complete truth for the
 * message, as `replaceAttachmentManifest` requires.
 *
 * SEQUENTIAL, DELIBERATELY. Each read charges the in-flight byte budget shared
 * with every download on the box; five in parallel would let one heavy forward
 * 503 the sender's own reading. The size check runs BEFORE the first read, so a
 * set that cannot fit costs no bytes to discover.
 */
export async function collectForwardAttachments(
  tenantId: string,
  original: { gmailMessageId: string; threadId: string | null; parsed: AttachmentMeta[] },
  deps: Partial<ForwardCarryDeps> = {},
): Promise<OutgoingAttachment[]> {
  const d = { ...defaultDeps, ...deps };
  const expected = forwardableParts(original.parsed);
  if (expected.length === 0) return [];

  const verdict = validateOutgoingAttachments(
    expected.map((part) => ({ filename: part.filename, sizeBytes: part.sizeBytes })),
  );
  if (!verdict.ok) {
    throw new ForwardAttachmentsUnavailableError(
      "too_large",
      expected.map((part) => part.filename),
      verdict.reason,
    );
  }

  let rows = await d.listMessageAttachments(tenantId, original.gmailMessageId);
  // Never-stored manifest, or one that predates a part: write it from the
  // payload already in hand. No Gmail call — resolveForwardTarget fetched it.
  if (expected.some((part) => !rows.some((row) => row.partId === part.partId))) {
    await d.replaceAttachmentManifest(tenantId, original.gmailMessageId, original.threadId, original.parsed);
    rows = await d.listMessageAttachments(tenantId, original.gmailMessageId);
  }
  const byPart = new Map(rows.map((row) => [row.partId, row]));

  const missing: string[] = [];
  const carried: OutgoingAttachment[] = [];
  for (const part of expected) {
    const row = byPart.get(part.partId);
    if (!row) {
      missing.push(part.filename);
      continue;
    }

    let payload: Awaited<ReturnType<typeof getAttachmentBytes>>;
    try {
      payload = await d.getAttachmentBytes(tenantId, row.id);
    } catch (err) {
      // Gone from Gmail is drift and is reported by name. Anything else —
      // storage down, the box busy — is transient and keeps its own error
      // (and status) so the caller answers "try again", not "it's gone".
      if ((err as { status?: unknown })?.status === 404) {
        missing.push(part.filename);
        continue;
      }
      throw err;
    }
    if (!payload) {
      missing.push(part.filename);
      continue;
    }
    // Once anything is missing the send is off: the later parts are checked
    // only so the error can name every one, and their streams are dropped
    // unread rather than buffered for nothing.
    if (missing.length > 0) {
      await payload.body.cancel().catch(() => {});
      continue;
    }
    const bytes = Buffer.from(await new Response(payload.body).arrayBuffer());
    carried.push({ filename: row.filename, mimeType: row.mimeType, content: bytes });
  }

  if (missing.length > 0) throw new ForwardAttachmentsUnavailableError("missing", missing);
  return carried;
}

/**
 * Carry the original's files (unless explicitly omitted), add the sender's own,
 * check the combined set, and only then hand everything to `send`.
 *
 * `send` is a parameter rather than a call inside so the ordering is the thing
 * tested: no path reaches it with an incomplete set.
 */
export async function forwardWithOriginalAttachments<T>(
  tenantId: string,
  params: {
    original: { gmailMessageId: string; threadId: string | null; parsed: AttachmentMeta[] };
    /** Files the sender attached to the forward itself. */
    extra: OutgoingAttachment[];
    /** The sender chose, explicitly, to forward without the original's files. */
    omitOriginalAttachments: boolean;
    send: (attachments: OutgoingAttachment[]) => Promise<T>;
  },
  deps: Partial<ForwardCarryDeps> = {},
): Promise<T> {
  const carried = params.omitOriginalAttachments
    ? []
    : await collectForwardAttachments(tenantId, params.original, deps);

  const all = [...carried, ...params.extra];

  // Combined check. The original's parts fit on their own, but the sender's
  // additions can push the total over — neither half alone shows that.
  if (all.length > 0) {
    const verdict = validateOutgoingAttachments(
      all.map((a) => ({ filename: a.filename, sizeBytes: a.content.byteLength })),
    );
    if (!verdict.ok) throw new Error(verdict.reason);
  }

  return params.send(all);
}
