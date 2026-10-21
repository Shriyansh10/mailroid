import { logger } from "@repo/logger";

import { gmailRequestWithAuthRecovery, type GmailRequestHooks } from "../gmail/gmail-request.ts";
import { classifyGmailFailure, type GmailCallContext } from "../gmail/gmail-errors.ts";
import { assertSyncAllowed, handleGmailFailure, markGmailHealthy } from "../gmail/quota-cooldown.ts";
import { extractAttachments } from "./parse.ts";
import { fetchMessageStructure } from "./structure.ts";
import { dbAttachmentStore } from "./store.ts";
import type { AttachmentRecord, AttachmentStore } from "./types.ts";

/**
 * A Gmail HTTP failure on the attachment path, carrying its status.
 *
 * THE `status` FIELD IS LOAD-BEARING. `classifyGmailFailure` / `isQuotaError`
 * read `.status` first; a plain `new Error("429 ...")` would be classified by
 * string-matching instead and could be retried rather than recorded as a
 * cooldown. webhook-sync.ts hit exactly this in production (quota-cooldown.ts).
 */
export class GmailHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GmailHttpError";
  }
}

/** The attachment is gone from the message in Gmail — real drift, said plainly. */
export class AttachmentGoneError extends Error {
  readonly status = 404;
  constructor() {
    super("This attachment is no longer available on the original message in Gmail.");
    this.name = "AttachmentGoneError";
  }
}

/**
 * Thrown when the hard attempt cap is reached. 503 so the route answers
 * "try again later", which is true: the failures were transient (5xx/network)
 * or the cap would not have been reached.
 */
export class GmailAttemptsExhaustedError extends Error {
  readonly status = 503;
  constructor(readonly attempts: number) {
    super(`Gmail attachment fetch gave up after ${attempts} network attempts.`);
    this.name = "GmailAttemptsExhaustedError";
  }
}

/**
 * THE HARD CAP (P-6, docs/gmail-rate-limit-boundary.md §13).
 *
 * Counts every real network request made on behalf of ONE attachment fetch:
 * attachment downloads, the auth-recovery re-send inside
 * gmailRequestWithAuthRecovery, and the structure read for a rotated id. It is
 * enforced at the fetch boundary itself (a counting `fetchImpl`), so no retry or
 * recovery path — present or future — can exceed it.
 *
 * The previous implementation nested a 3-pass recovery loop inside a 5-try
 * retry wrapper, with its "already recovered" flags declared INSIDE the retried
 * closure, so they reset every try: worst case 5 × 5 = 25 full downloads of one
 * attachment. This replaces that structure rather than tuning it.
 *
 * Not counted: the 1-unit labels.list warm-up that a token refresh makes through
 * corsair. At most one per gmailRequestWithAuthRecovery call, never a download,
 * and it is charged and ledgered by that module itself.
 */
export const MAX_NETWORK_ATTEMPTS = 5;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

function attachmentUrl(gmailMessageId: string, gmailAttachmentId: string): string {
  // encodeURIComponent on both: these come from stored rows rather than request
  // input, but the URL must never be assemblable into a different path.
  return (
    `${GMAIL_API}/messages/${encodeURIComponent(gmailMessageId)}` +
    `/attachments/${encodeURIComponent(gmailAttachmentId)}`
  );
}

function decodeBody(json: unknown, gmailMessageId: string): Buffer {
  const data = (json as { data?: unknown } | null)?.data;
  if (typeof data !== "string" || data.length === 0) {
    throw new GmailHttpError(502, `Gmail returned an attachment with no data for message ${gmailMessageId}.`);
  }
  // Gmail sends base64url inside a JSON body; there is no `alt=media` on this
  // endpoint, so the decode (and its memory cost, see admission.ts) is unavoidable.
  return Buffer.from(data, "base64url");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export interface GmailFetchDeps {
  store: Pick<AttachmentStore, "refreshGmailAttachmentId">;
  request: typeof gmailRequestWithAuthRecovery;
  assertSyncAllowed: typeof assertSyncAllowed;
  handleGmailFailure: typeof handleGmailFailure;
  markGmailHealthy: typeof markGmailHealthy;
  /** Underlying network call; wrapped by the attempt counter. */
  fetchImpl: typeof fetch;
  requestHooks: Omit<GmailRequestHooks, "fetchImpl">;
  sleep: (ms: number) => Promise<void>;
  correlationId?: string;
}

/**
 * Fetch one attachment's bytes from Gmail, under the shared mailbox controls.
 *
 * API PROCESS ONLY. This is the single place attachment bytes leave Gmail; the
 * web process never imports it (a source-scan test enforces that).
 *
 * Order, and why:
 *   1. gate     — a paused or cooling mailbox is refused before any request
 *                 (assertSyncAllowed), exactly as withGmailRetry does.
 *   2. request  — gmailRequestWithAuthRecovery: quota pacing, the mailbox
 *                 semaphore, the call ledger WITH response bytes, and token
 *                 refresh on a 401.
 *   3. outcome  —
 *        2xx         decode, mark the mailbox healthy, return.
 *        404 (once)  the attachment id rotated: re-read the message STRUCTURE
 *                    (no content) and re-resolve by the stable part id.
 *        404 again   AttachmentGoneError — real drift, surfaced, never guessed.
 *        429/quota   record a cooldown and STOP. Never retried: retrying inside
 *                    Gmail's window pushes the window further out (retry.ts).
 *        auth        record it and stop; retrying dead credentials is pointless.
 *        5xx/network retried with backoff (honouring Retry-After), inside the cap.
 *        other 4xx   thrown with its status.
 */
export async function fetchAttachmentFromGmail(
  tenantId: string,
  record: AttachmentRecord,
  deps: Partial<GmailFetchDeps> = {},
): Promise<Buffer> {
  const store = deps.store ?? dbAttachmentStore;
  const request = deps.request ?? gmailRequestWithAuthRecovery;
  const gate = deps.assertSyncAllowed ?? assertSyncAllowed;
  const onFailure = deps.handleGmailFailure ?? handleGmailFailure;
  const onHealthy = deps.markGmailHealthy ?? markGmailHealthy;
  const baseFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const ctx: GmailCallContext = {
    trigger: "attachment-download",
    operation: "attachments.get",
    targetId: record.gmailMessageId,
    correlationId: deps.correlationId,
  };

  let attempts = 0;
  const countingFetch: typeof fetch = (input, init) => {
    if (attempts >= MAX_NETWORK_ATTEMPTS) {
      return Promise.reject(new GmailAttemptsExhaustedError(attempts));
    }
    attempts++;
    return baseFetch(input, init);
  };
  const hooks: GmailRequestHooks = { ...deps.requestHooks, fetchImpl: countingFetch };

  await gate(tenantId, ctx);

  let attachmentId = record.gmailAttachmentId;
  let reResolved = false;
  let transientFailures = 0;

  const backoff = async (res?: Response) => {
    const wait = Math.min(
      MAX_BACKOFF_MS,
      (res && retryAfterMs(res)) ?? BASE_BACKOFF_MS * 2 ** transientFailures + Math.random() * 250,
    );
    transientFailures++;
    await sleep(wait);
  };

  for (;;) {
    let res: Response;
    try {
      res = await request(tenantId, attachmentUrl(record.gmailMessageId, attachmentId), { ctx, hooks });
    } catch (err) {
      if (err instanceof GmailAttemptsExhaustedError) throw err;
      const kind = classifyGmailFailure(err);
      if (kind !== "other") {
        // Auth (refresh failed) or quota: record the state and stop.
        await onFailure(tenantId, err, ctx).catch(() => {});
        throw err;
      }
      // Transport failure — transient. The counter decides whether there is another try.
      logger.warn("[ATTACHMENTS] transient Gmail failure, retrying", {
        tenantId, gmailMessageId: record.gmailMessageId, attempts, error: String(err),
      });
      if (attempts >= MAX_NETWORK_ATTEMPTS) throw new GmailAttemptsExhaustedError(attempts);
      await backoff();
      continue;
    }

    if (res.ok) {
      const bytes = decodeBody(await res.json(), record.gmailMessageId);
      await onHealthy(tenantId, { ...ctx, recoveredBy: "live-call-succeeded" }).catch((err: unknown) => {
        logger.error("[ATTACHMENTS] markGmailHealthy failed after a successful fetch", {
          tenantId, error: String(err),
        });
      });
      return bytes;
    }

    if (res.status === 404) {
      if (reResolved) throw new AttachmentGoneError();
      reResolved = true;
      logger.info("[ATTACHMENTS] attachment id rotated, re-resolving from part", {
        tenantId, gmailMessageId: record.gmailMessageId, partId: record.partId,
      });
      // Structure only (no body data), through the same counter and controls.
      const message = await fetchMessageStructure(tenantId, record.gmailMessageId, {
        ctx: { ...ctx, operation: "messages.get" },
        hooks,
      });
      const next = extractAttachments(message.payload).find((p) => p.partId === record.partId)?.gmailAttachmentId;
      if (!next) throw new AttachmentGoneError();
      attachmentId = next;
      await store.refreshGmailAttachmentId(record.id, next).catch((err: unknown) => {
        // Persisting the new id is an optimisation for next time; it must not
        // fail the download we can now complete.
        logger.warn("[ATTACHMENTS] could not persist refreshed attachment id", {
          attachmentId: record.id, error: String(err),
        });
      });
      continue;
    }

    const err = new GmailHttpError(
      res.status,
      `Gmail attachment fetch failed: ${res.status}`,
      safeJson(await res.text().catch(() => "")),
    );
    const kind = classifyGmailFailure(err);
    if (kind !== "other") {
      // 429 / rate-limit 403 / auth: record and stop. Never retried here.
      await onFailure(tenantId, err, ctx).catch(() => {});
      throw err;
    }
    if (res.status >= 500) {
      logger.warn("[ATTACHMENTS] Gmail 5xx, retrying", {
        tenantId, gmailMessageId: record.gmailMessageId, status: res.status, attempts,
      });
      if (attempts >= MAX_NETWORK_ATTEMPTS) throw new GmailAttemptsExhaustedError(attempts);
      await backoff(res);
      continue;
    }
    throw err;
  }
}
