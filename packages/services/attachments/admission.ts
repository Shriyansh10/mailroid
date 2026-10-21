import { logger } from "@repo/logger";

import { MAX_UPLOAD_BYTES } from "../gmail/attachment-limits.ts";
import { AttachmentBusyError } from "./types.ts";

/**
 * Memory admission for attachment bytes held in process memory.
 *
 * TWO BUDGETS, TWO CONTAINERS — and that is new. Downloads and uploads used to
 * share one counter because both ran in the web container. Gmail downloads now
 * run ONLY in the API container (ensure-stored.ts: object storage is the read
 * source, and only the API populates it), while uploads stay in the web
 * container's send route. Each container is sized against its own memory cap,
 * so each gets its own budget; a shared counter across two processes would be
 * a counter in neither.
 */

/**
 * Hard ceiling for ONE attachment on the read path: Gmail's user-facing
 * allowance for the files on a message (MAX_TOTAL_RAW_BYTES), so one file may
 * use the whole allowance, never more. Not Gmail's 35 MiB per-MESSAGE MIME
 * ceiling — see the two-ceilings note in gmail/attachment-limits.ts.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * RETAINED memory cost of one concurrent Gmail fetch, as a multiple of file
 * size. Measured on the real path (Gmail-shaped JSON, 25 MB files, K at once):
 * RSS ≈ 126 MB + 1.08 × concurrent bytes; worst marginal 2.03x. 2 covers the
 * observed worst case and deliberately not the one-off transient spike, which
 * is reserved once below instead of charged per request.
 */
export const RETAINED_MULTIPLIER = 2;

/**
 * API-container ceiling on concurrently admitted DOWNLOAD bytes.
 *
 *   container cap     384 MB (--memory 384m, mailroid-deploy.yml)
 *   idle              ~130 MB measured
 *   burst reserve     128 MB (fixed cost of any burst, measured on the web path)
 *   128 MB budget / 2x  =  64 MB of real concurrent bytes
 *   peak ≈ 130 + 128 + 1.08 × 64  ≈  327 MB  of 384
 *
 * Admits two maximum-size attachments at once (GUARD 1 below). The 126/128 MB
 * burst figure was measured in the WEB container; it is reused here pending a
 * re-measurement in the API container, and the margin (~57 MB) is the
 * allowance for that. Re-measure before raising this.
 */
export const MAX_INFLIGHT_DOWNLOAD_BYTES = 128 * 1024 * 1024;

/** Fairness: one tab spamming clicks must not monopolise the budget. */
export const MAX_CONCURRENT_MISSES_PER_USER = 2;

/**
 * Upload side (web container, send route). The multipart parser materialises
 * the file and the MIME builder holds the ~1.37x base64 string alongside it, so
 * 3 is a deliberate over-estimate pending measurement.
 */
export const UPLOAD_RETAINED_MULTIPLIER = 3;
export const MAX_CONCURRENT_UPLOADS_PER_USER = 1;

/**
 * Web-container ceiling on concurrently admitted UPLOAD bytes. Unchanged from
 * when uploads and downloads shared it: 1967 MB box, web capped at 512m, web
 * idle ~122 MB. With downloads gone from this container the margin only grew.
 */
export const MAX_INFLIGHT_UPLOAD_BYTES = 256 * 1024 * 1024;

/**
 * GUARD 1 — the size gate and the budget must not disagree. If the largest
 * attachment the gate admits cannot fit the budget, every size in between
 * passes the 413 check and is refused by admission forever, on an idle server.
 * That shipped once (16–25 MiB permanently undownloadable). Literal constants
 * only, checked at module load: a mismatched edit refuses to start.
 */
if (MAX_ATTACHMENT_BYTES * RETAINED_MULTIPLIER > MAX_INFLIGHT_DOWNLOAD_BYTES) {
  throw new Error(
    `[ATTACHMENTS] download limits disagree: MAX_ATTACHMENT_BYTES (${MAX_ATTACHMENT_BYTES}) x ` +
      `RETAINED_MULTIPLIER (${RETAINED_MULTIPLIER}) exceeds MAX_INFLIGHT_DOWNLOAD_BYTES ` +
      `(${MAX_INFLIGHT_DOWNLOAD_BYTES}).`,
  );
}

/** GUARD 1b — the same for uploads. */
if (MAX_UPLOAD_BYTES * UPLOAD_RETAINED_MULTIPLIER > MAX_INFLIGHT_UPLOAD_BYTES) {
  throw new Error(
    `[ATTACHMENTS] upload limits disagree: MAX_UPLOAD_BYTES (${MAX_UPLOAD_BYTES}) x ` +
      `UPLOAD_RETAINED_MULTIPLIER (${UPLOAD_RETAINED_MULTIPLIER}) exceeds MAX_INFLIGHT_UPLOAD_BYTES ` +
      `(${MAX_INFLIGHT_UPLOAD_BYTES}).`,
  );
}

let downloadBytes = 0;
const downloadsPerUser = new Map<string, number>();
let uploadBytes = 0;
const uploadsPerUser = new Map<string, number>();

/**
 * Reserve download budget for one Gmail fetch (API container), or refuse.
 * Charged only when a fetch actually starts; a request joining an in-flight
 * fetch for the same attachment rides along for free.
 */
export function admitDownload(userId: string, sizeBytes: number): () => void {
  const cost = sizeBytes * RETAINED_MULTIPLIER;
  const userCount = downloadsPerUser.get(userId) ?? 0;

  if (userCount >= MAX_CONCURRENT_MISSES_PER_USER) {
    logger.warn("[ATTACHMENTS] refused: per-user concurrency cap", { userId, sizeBytes, userCount });
    throw new AttachmentBusyError(2);
  }
  // GUARD 2 — the only thing in flight is always admitted, so a legal
  // attachment can never become permanently undownloadable on an idle server.
  if (downloadBytes > 0 && downloadBytes + cost > MAX_INFLIGHT_DOWNLOAD_BYTES) {
    logger.warn("[ATTACHMENTS] refused: in-flight byte budget exhausted", {
      userId, sizeBytes, cost, inflight: downloadBytes, budget: MAX_INFLIGHT_DOWNLOAD_BYTES,
    });
    throw new AttachmentBusyError(2);
  }

  downloadBytes += cost;
  downloadsPerUser.set(userId, userCount + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    downloadBytes -= cost;
    const n = (downloadsPerUser.get(userId) ?? 1) - 1;
    if (n <= 0) downloadsPerUser.delete(userId);
    else downloadsPerUser.set(userId, n);
  };
}

/** Reserve upload budget for one outbound message (web container), or refuse. */
export function admitUpload(userId: string, sizeBytes: number): () => void {
  const cost = sizeBytes * UPLOAD_RETAINED_MULTIPLIER;
  const userCount = uploadsPerUser.get(userId) ?? 0;

  if (userCount >= MAX_CONCURRENT_UPLOADS_PER_USER) {
    logger.warn("[ATTACHMENTS] upload refused: per-user concurrency cap", { userId, sizeBytes });
    throw new AttachmentBusyError(5);
  }
  if (uploadBytes > 0 && uploadBytes + cost > MAX_INFLIGHT_UPLOAD_BYTES) {
    logger.warn("[ATTACHMENTS] upload refused: in-flight byte budget exhausted", {
      userId, sizeBytes, cost, inflight: uploadBytes, budget: MAX_INFLIGHT_UPLOAD_BYTES,
    });
    throw new AttachmentBusyError(5);
  }

  uploadBytes += cost;
  uploadsPerUser.set(userId, userCount + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    uploadBytes -= cost;
    const n = (uploadsPerUser.get(userId) ?? 1) - 1;
    if (n <= 0) uploadsPerUser.delete(userId);
    else uploadsPerUser.set(userId, n);
  };
}

/** Test seam — module-global counters would leak between cases. */
export function __resetInflightBudget(): void {
  downloadBytes = 0;
  downloadsPerUser.clear();
  uploadBytes = 0;
  uploadsPerUser.clear();
}
