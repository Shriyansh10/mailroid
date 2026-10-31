import crypto from "node:crypto";

import { logger } from "@repo/logger";

import { classifyGmailFailure, GmailPacedOutError } from "../gmail/gmail-errors.ts";
import { ensureAttachmentStored } from "./ensure-stored.ts";
import { AttachmentGoneError, GmailAttemptsExhaustedError } from "./gmail-fetch.ts";
import { AttachmentBusyError, AttachmentTooLargeError, StorageUnavailableError } from "./types.ts";

/**
 * The API side of POST /internal/attachments/ensure — pure, so it is testable
 * without Express. API PROCESS ONLY.
 *
 * TWO CHECKS, NEVER ONE:
 *   1. The caller presents INTERNAL_API_SECRET (constant-time compare). That
 *      authenticates the calling SERVICE.
 *   2. ensureAttachmentStored runs findOwned(userId, attachmentId). That is the
 *      user-level authorization, and the secret does not replace it: a valid
 *      secret with a mismatched user/attachment pair gets 404.
 *
 * The secret is never logged, echoed, or included in a response. A configured
 * secret shorter than 32 characters is treated as not configured, so a weak
 * placeholder can never open the endpoint.
 */

export const MIN_SECRET_LENGTH = 32;

export function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface InternalEnsureRequest {
  secretHeader: string | undefined;
  body: unknown;
}

export interface InternalEnsureResponse {
  status: number;
  json: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface InternalEnsureDeps {
  expectedSecret: string | undefined;
  ensure: typeof ensureAttachmentStored;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleInternalEnsure(
  req: InternalEnsureRequest,
  deps: Partial<InternalEnsureDeps> = {},
): Promise<InternalEnsureResponse> {
  const expected = deps.expectedSecret ?? process.env.INTERNAL_API_SECRET;
  const ensure = deps.ensure ?? ensureAttachmentStored;

  if (!expected || expected.length < MIN_SECRET_LENGTH) {
    logger.error("[ATTACHMENTS] internal endpoint called but INTERNAL_API_SECRET is unset or too short");
    return { status: 503, json: { error: "not_configured" } };
  }
  if (!secretMatches(req.secretHeader, expected)) {
    logger.warn("[ATTACHMENTS] internal endpoint rejected: missing or invalid service secret");
    return { status: 401, json: { error: "unauthorized" } };
  }

  const body = (req.body ?? {}) as { userId?: unknown; attachmentId?: unknown };
  if (typeof body.userId !== "string" || body.userId.length === 0 || body.userId.length > 128) {
    return { status: 400, json: { error: "invalid_user" } };
  }
  if (typeof body.attachmentId !== "string" || !UUID.test(body.attachmentId)) {
    return { status: 400, json: { error: "invalid_attachment" } };
  }
  const { userId, attachmentId } = body as { userId: string; attachmentId: string };

  try {
    const outcome = await ensure(userId, attachmentId);
    if (outcome.status === "not_found") return { status: 404, json: { error: "not_found" } };
    return { status: 200, json: { status: "stored", key: outcome.key } };
  } catch (err) {
    if (err instanceof AttachmentTooLargeError) {
      return { status: 413, json: { error: "too_large", sizeBytes: err.sizeBytes, limitBytes: err.limitBytes } };
    }
    if (err instanceof AttachmentBusyError) {
      return {
        status: 503,
        json: { error: "busy", retryAfterSeconds: err.retryAfterSeconds },
        headers: { "Retry-After": String(err.retryAfterSeconds) },
      };
    }
    if (err instanceof StorageUnavailableError) {
      return { status: 503, json: { error: "storage_unavailable", reason: err.reason } };
    }
    if (err instanceof AttachmentGoneError) {
      return { status: 410, json: { error: "gone" } };
    }
    if (err instanceof GmailAttemptsExhaustedError) {
      return { status: 503, json: { error: "gmail_unavailable" } };
    }
    if (err instanceof GmailPacedOutError) {
      // Our own pacer declined to schedule it within the interactive cap: the
      // mailbox is busy, Gmail was never called. Retryable shortly.
      return {
        status: 503,
        json: { error: "busy", retryAfterSeconds: 5 },
        headers: { "Retry-After": "5" },
      };
    }
    if (classifyGmailFailure(err) === "quota") {
      return { status: 429, json: { error: "rate_limited" } };
    }
    const status = (err as { status?: unknown })?.status;
    if (status === 503) return { status: 503, json: { error: "unavailable" } };

    logger.error("[ATTACHMENTS] internal ensure failed", {
      userId, attachmentId, error: String((err as Error)?.message ?? err),
    });
    return { status: 500, json: { error: "internal" } };
  }
}
