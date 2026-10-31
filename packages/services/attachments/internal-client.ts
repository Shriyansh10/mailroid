import { logger } from "@repo/logger";

import { AttachmentTooLargeError, StorageUnavailableError, type AttachmentMissHandler } from "./types.ts";
import { AttachmentBusyError } from "./types.ts";

/**
 * WEB PROCESS → API: "populate storage with this attachment".
 *
 * The web process never downloads attachments from Gmail. On a confirmed
 * storage miss it calls the API's internal endpoint, which does the one Gmail
 * download under the shared mailbox controls, writes storage, and confirms.
 *
 * Authentication is a shared service secret (INTERNAL_API_SECRET), because the
 * callers include forward and draft-send paths that hold a user id but no
 * session cookie. The secret authenticates THIS SERVICE; the API still checks
 * that the attachment belongs to the user id sent. The secret is sent only in a
 * request header, never logged, and never included in any error message.
 *
 * The endpoint is reachable only on the private network: Caddy does not route
 * /internal/* to the API, so API_INTERNAL_URL must be the in-network address
 * (http://mailroid-api:8000 in production, http://localhost:8000 in dev).
 */

const ENSURE_PATH = "/internal/attachments/ensure";
const TIMEOUT_MS = 120_000;

export interface InternalClientConfig {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
}

/** Read from env at call time, never at import (next build has no secrets). */
export function internalClientConfigFromEnv(): InternalClientConfig | null {
  const baseUrl = process.env.API_INTERNAL_URL?.trim();
  const secret = process.env.INTERNAL_API_SECRET;
  if (!baseUrl || !secret) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), secret };
}

export function createInternalMissHandler(config: InternalClientConfig): AttachmentMissHandler {
  const doFetch = config.fetchImpl ?? fetch;

  return async (userId, attachmentId) => {
    let res: Response;
    try {
      res = await doFetch(`${config.baseUrl}${ENSURE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": config.secret,
        },
        body: JSON.stringify({ userId, attachmentId }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.error("[ATTACHMENTS] internal ensure request failed", {
        userId, attachmentId, error: String((err as Error)?.message ?? err),
      });
      throw new StorageUnavailableError("error");
    }

    if (res.status === 200) {
      const body = (await res.json()) as { status?: string; key?: string };
      if (body.status === "stored" && typeof body.key === "string") return { status: "stored", key: body.key };
      throw new StorageUnavailableError("error");
    }
    if (res.status === 404) return { status: "not_found" };

    // Map the API's typed refusals back to the same errors an in-process call
    // would throw, so the route answers identically in both processes.
    const payload = (await res.json().catch(() => ({}))) as { error?: string; sizeBytes?: number; limitBytes?: number; retryAfterSeconds?: number };
    if (res.status === 413 && payload.sizeBytes && payload.limitBytes) {
      throw new AttachmentTooLargeError(payload.sizeBytes, payload.limitBytes);
    }
    if (res.status === 503 && payload.error === "busy") {
      throw new AttachmentBusyError(payload.retryAfterSeconds ?? 2);
    }
    if (res.status === 410) {
      const err = new Error("This attachment is no longer available on the original message in Gmail.");
      (err as Error & { status: number }).status = 404;
      throw err;
    }
    if (res.status === 429) {
      const err = new Error("Gmail is rate-limiting this mailbox. Try again later.");
      (err as Error & { status: number }).status = 429;
      throw err;
    }
    // 401 here means the two services' secrets disagree: a deployment fault,
    // logged as such, surfaced to the user as plain unavailability.
    logger.error("[ATTACHMENTS] internal ensure refused", { userId, attachmentId, status: res.status });
    throw new StorageUnavailableError("error");
  };
}
