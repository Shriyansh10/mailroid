/**
 * Reading a message's MIME STRUCTURE from Gmail without its content.
 *
 * WHY THIS EXISTS. Two paths need to know which attachment parts a message has
 * without downloading anything: the manifest backfill (list tiles for mail
 * nobody has opened) and the 404 recovery in gmail-fetch.ts (Gmail rotated an
 * attachment id; find the part again). A plain `format=full` read answers both,
 * but it also ships the message body — text always, and small parts inline in
 * `body.data`. Parsing that and throwing it away still means downloading it.
 *
 * So these requests use Gmail's partial-response `fields` parameter. Gmail
 * filters server-side and returns only the fields named; `body.data` is never
 * named, so it is never sent — for attachments or for message text. The guard
 * is Gmail's response filter, not our discipline after the fact.
 *
 * WHAT IS ASKED FOR, per part: partId, mimeType, filename, headers (for
 * Content-Disposition and Content-ID, which decide inline vs attachment — see
 * parse.ts), body.size and body.attachmentId. That is exactly what
 * `extractAttachments` reads. Part headers are a handful of short lines; the
 * root part's headers are the message headers, which are metadata the sync
 * already stores.
 *
 * DEPTH. A `fields` mask cannot say "recursively", so nested `parts` are spelled
 * out to a fixed depth. Real mail rarely nests past four levels
 * (mixed → related → alternative → leaf). A tree deeper than the mask comes back
 * with a `multipart/*` part whose `parts` are missing; `isStructureTruncated`
 * detects that, and callers must treat the structure as INCOMPLETE rather than
 * as "no more attachments". Writing a partial manifest would show one tile out
 * of two as if it were the whole set.
 *
 * Every request goes through gmailRequestWithAuthRecovery, so it is paced,
 * concurrency-limited, ledgered with its response bytes, and token-refreshing —
 * the same controls as every other raw Gmail call.
 */
import { gmailRequestWithAuthRecovery, type GmailRequestHooks } from "../gmail/gmail-request.ts";
import type { GmailCallContext } from "../gmail/gmail-errors.ts";
import type { ParsablePart } from "./parse.ts";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Levels of `parts(...)` spelled out in the mask, below the root payload. */
export const STRUCTURE_MASK_DEPTH = 8;

const PART_FIELDS = "partId,mimeType,filename,headers(name,value),body(size,attachmentId)";

/** The `fields` sub-mask for one part and its descendants. Never contains `data`. */
export function partMask(depth: number = STRUCTURE_MASK_DEPTH): string {
  return depth > 0 ? `${PART_FIELDS},parts(${partMask(depth - 1)})` : PART_FIELDS;
}

export const MESSAGE_STRUCTURE_FIELDS = `id,threadId,payload(${partMask()})`;
export const THREAD_STRUCTURE_FIELDS = `id,messages(${MESSAGE_STRUCTURE_FIELDS})`;

export interface StructuredMessage {
  id: string;
  threadId?: string;
  payload?: ParsablePart;
}

export interface StructuredThread {
  id: string;
  messages: StructuredMessage[];
}

/**
 * True when some multipart container came back without its children: the tree
 * is deeper than the mask and the part list is incomplete. A genuinely empty
 * multipart container is malformed mail, and treating it as incomplete costs
 * nothing worse than leaving the full read to hydration or thread open.
 */
export function isStructureTruncated(part: ParsablePart | undefined): boolean {
  if (!part) return false;
  const isContainer = (part.mimeType ?? "").startsWith("multipart/");
  if (isContainer && !(part.parts && part.parts.length > 0)) return true;
  return (part.parts ?? []).some(isStructureTruncated);
}

export class GmailStructureError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GmailStructureError";
  }
}

interface StructureOpts {
  ctx: GmailCallContext;
  hooks?: GmailRequestHooks;
}

async function getJson<T>(tenantId: string, url: string, opts: StructureOpts): Promise<T> {
  const res = await gmailRequestWithAuthRecovery(tenantId, url, { ctx: opts.ctx, hooks: opts.hooks });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the text */
    }
    throw new GmailStructureError(res.status, `Gmail structure read failed: ${res.status}`, body);
  }
  return (await res.json()) as T;
}

/** One message's part tree, without any body data. */
export function fetchMessageStructure(
  tenantId: string,
  gmailMessageId: string,
  opts: StructureOpts,
): Promise<StructuredMessage> {
  const url =
    `${GMAIL_API}/messages/${encodeURIComponent(gmailMessageId)}` +
    `?format=full&fields=${encodeURIComponent(MESSAGE_STRUCTURE_FIELDS)}`;
  return getJson<StructuredMessage>(tenantId, url, opts);
}

/** Every message's part tree in one thread, without any body data. One call. */
export async function fetchThreadStructure(
  tenantId: string,
  threadId: string,
  opts: StructureOpts,
): Promise<StructuredThread> {
  const url =
    `${GMAIL_API}/threads/${encodeURIComponent(threadId)}` +
    `?format=full&fields=${encodeURIComponent(THREAD_STRUCTURE_FIELDS)}`;
  const thread = await getJson<{ id: string; messages?: StructuredMessage[] }>(tenantId, url, opts);
  return { id: thread.id, messages: thread.messages ?? [] };
}

export const DRAFT_STRUCTURE_FIELDS = `id,message(${MESSAGE_STRUCTURE_FIELDS})`;

/** A draft's current message and its part tree, without any body data. */
export async function fetchDraftStructure(
  tenantId: string,
  draftId: string,
  opts: StructureOpts,
): Promise<StructuredMessage | null> {
  const url =
    `${GMAIL_API}/drafts/${encodeURIComponent(draftId)}` +
    `?format=full&fields=${encodeURIComponent(DRAFT_STRUCTURE_FIELDS)}`;
  const draft = await getJson<{ id: string; message?: StructuredMessage }>(tenantId, url, opts);
  return draft.message ?? null;
}
