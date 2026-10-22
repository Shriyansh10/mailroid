/**
 * Attachment metadata as the model is allowed to see it. Filenames and From
 * headers are mailbox text, masked through model-masking.ts (see there for why
 * the agent loop's own pass is not enough).
 */
import { maskForModel, parseFromHeader } from "./model-masking.ts";

export { maskForModel, parseFromHeader };

export interface AttachmentForModel {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** One message's files for a summary. `null` (unknown) stays null — never `[]`. */
export function attachmentsForModel(
  rows: Array<{ filename: string; mimeType: string; sizeBytes: number }> | null,
): AttachmentForModel[] | null {
  if (rows === null) return null;
  return rows.map((row) => ({
    filename: maskForModel(row.filename) || "attachment",
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
  }));
}

// ── Sender identity ─────────────────────────────────────────────────────

/**
 * Distinct PEOPLE among matching From headers: grouped by address, so one
 * sender who appears as both "Ravi Kumar <r@a.com>" and "r@a.com" is one
 * match, while two different Ravis are two.
 */
export function distinctSenders(headers: string[]): Array<{ address: string; displayName: string }> {
  const byAddress = new Map<string, string>();
  for (const header of headers) {
    const { name, address } = parseFromHeader(header);
    const key = address || name.toLowerCase();
    if (!key) continue;
    if (!byAddress.has(key) || (!byAddress.get(key) && name)) byAddress.set(key, name);
  }
  return [...byAddress.entries()].map(([address, name]) => ({
    address,
    // A name when there is one; otherwise the address, masked like any other.
    displayName: maskForModel(name || address),
  }));
}

// ── findAttachments result ──────────────────────────────────────────────

export interface FoundAttachmentInput {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  entityId: string;
  threadId: string | null;
  receivedAt: Date | string | null;
  sender: string | null;
}

export interface FindAttachmentsResult {
  files: Array<{
    attachmentId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    entityId: string;
    threadId: string | null;
    receivedAt: string | null;
    sender: string;
  }>;
  sender?: {
    /** What the user asked for, as given. */
    query: string;
    /** Distinct people whose mail matches. 0 = nobody; >1 = ask which. */
    matched: number;
    /** Their names, only when there is more than one to choose between. */
    names?: string[];
  };
  coverage: { awaitingList: number; unknownStatus: number };
  /** Plain-language statement of what was and wasn't searched. */
  note: string;
}

export function shapeFindAttachmentsResult(input: {
  files: FoundAttachmentInput[];
  senderQuery?: string;
  matchingSenderHeaders: string[];
  coverage: { awaitingList: number; unknownStatus: number };
}): FindAttachmentsResult {
  const files = input.files.map((f) => ({
    attachmentId: f.attachmentId,
    filename: maskForModel(f.filename) || "attachment",
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    entityId: f.entityId,
    threadId: f.threadId,
    receivedAt: f.receivedAt ? new Date(f.receivedAt).toISOString() : null,
    sender: f.sender ? distinctSenders([f.sender])[0]?.displayName ?? "" : "",
  }));

  let sender: FindAttachmentsResult["sender"];
  const query = input.senderQuery?.trim();
  if (query) {
    const people = distinctSenders(input.matchingSenderHeaders);
    sender = {
      query,
      matched: people.length,
      ...(people.length > 1 ? { names: people.map((p) => p.displayName) } : {}),
    };
  }

  const unchecked = input.coverage.awaitingList + input.coverage.unknownStatus;
  const parts: string[] = [];
  if (sender?.matched === 0) {
    parts.push(`No mail from anyone matching "${query}" was found, so there are no files from them to list.`);
  } else if (sender && sender.matched > 1) {
    parts.push(`"${query}" matches ${sender.matched} different senders; ask the user which one they mean.`);
  }
  if (unchecked > 0) {
    parts.push(
      `Only mail Mailroid has checked for attachments was searched: ${unchecked} message${unchecked === 1 ? "" : "s"} in this range ${unchecked === 1 ? "was" : "were"} not checked by file name.`,
    );
  }
  return { files, ...(sender ? { sender } : {}), coverage: input.coverage, note: parts.join(" ") };
}
