/**
 * Object storage for account deletion: purge a user's prefix, and scan it.
 *
 * Every object Mailroid writes for a user lives under
 * `${keyPrefix}/attachments/${userId}/` (attachments/keys.ts — the only key
 * builder, used by both writers: ensure-stored and draft-attachments). Keys
 * recorded on rows are deleted too, in case an older key format ever existed.
 *
 * FAIL CLOSED, EVERYWHERE. A listing error, a delete error, or an incomplete
 * page makes the result incomplete, and an incomplete result can never verify
 * a deletion. "We couldn't look" is never reported as "we looked and it was
 * empty".
 *
 * Unfinished multipart uploads are invisible to ListObjectsV2 and become
 * objects if completed later, so they are listed and aborted separately.
 *
 * Per-key DeleteObject rather than the batch DeleteObjects: the batch call
 * requires a body checksum, and the checksum settings Spaces needs
 * (s3-storage.ts) make that path unproven. Single deletes are idempotent and
 * report per-key status. REAL-SERVICE CHECK PENDING: none of this has run
 * against the staging bucket yet (Phase 0 steps 7a–7k).
 */

import {
  S3Client,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import { resolveAttachmentCacheConfig, type AttachmentCacheConfig } from "../attachments/config.ts";

export interface DeletionObjectStore {
  keyPrefix: string;
  listObjects(prefix: string, token?: string): Promise<{ keys: string[]; next?: string }>;
  listUploads(
    prefix: string,
    marker?: { key: string; uploadId: string },
  ): Promise<{ uploads: { key: string; uploadId: string }[]; next?: { key: string; uploadId: string } }>;
  deleteObject(key: string): Promise<void>;
  abortUpload(key: string, uploadId: string): Promise<void>;
}

/** The prefix holding every object for this user. Guarded: never a parent. */
export function userPrefix(keyPrefix: string, userId: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(keyPrefix)) throw new Error(`[account-deletion] bad key prefix "${keyPrefix}"`);
  if (!userId || userId.includes("/") || userId.includes("..") || userId.trim() !== userId) {
    throw new Error(`[account-deletion] refusing storage prefix for user id "${userId}"`);
  }
  return `${keyPrefix}/attachments/${userId}/`;
}

export interface StoragePurgeResult {
  /** True only when every listing completed and every delete succeeded. */
  complete: boolean;
  deleted: number;
  abortedUploads: number;
  failures: { key: string; error: string }[];
}

const DELETE_CONCURRENCY = 8;

export async function purgeUserObjects(
  store: DeletionObjectStore,
  userId: string,
  recordedKeys: string[],
): Promise<StoragePurgeResult> {
  const prefix = userPrefix(store.keyPrefix, userId);
  const failures: { key: string; error: string }[] = [];
  const keys = new Set<string>();

  // Keys recorded on rows that fall outside the prefix are still this user's;
  // anything under another user's prefix is refused, not deleted.
  for (const k of recordedKeys) {
    if (k.startsWith(prefix)) keys.add(k);
    else if (k.includes("/attachments/") && !k.startsWith(prefix)) {
      failures.push({ key: k, error: "recorded key is under another prefix; not deleted, needs review" });
    } else keys.add(k);
  }

  let listingComplete = true;
  try {
    let token: string | undefined;
    do {
      const page = await store.listObjects(prefix, token);
      for (const k of page.keys) keys.add(k);
      token = page.next;
    } while (token);
  } catch (err) {
    listingComplete = false;
    failures.push({ key: prefix, error: `listing failed: ${errText(err)}` });
  }

  let deleted = 0;
  const queue = [...keys];
  await Promise.all(
    Array.from({ length: Math.min(DELETE_CONCURRENCY, queue.length) }, async () => {
      for (let k = queue.shift(); k !== undefined; k = queue.shift()) {
        try {
          await store.deleteObject(k);
          deleted++;
        } catch (err) {
          failures.push({ key: k, error: errText(err) });
        }
      }
    }),
  );

  let abortedUploads = 0;
  try {
    let marker: { key: string; uploadId: string } | undefined;
    do {
      const page = await store.listUploads(prefix, marker);
      for (const u of page.uploads) {
        try {
          await store.abortUpload(u.key, u.uploadId);
          abortedUploads++;
        } catch (err) {
          failures.push({ key: `${u.key}#${u.uploadId}`, error: `abort failed: ${errText(err)}` });
        }
      }
      marker = page.next;
    } while (marker);
  } catch (err) {
    listingComplete = false;
    failures.push({ key: prefix, error: `multipart listing failed: ${errText(err)}` });
  }

  return { complete: listingComplete && failures.length === 0, deleted, abortedUploads, failures };
}

export interface ScanResult {
  /** False when any listing failed — the counts below are then meaningless. */
  complete: boolean;
  startedAt: Date;
  objects: number;
  uploads: number;
  sampleKeys: string[];
  error?: string;
}

/** Full listing of the user's prefix: objects and unfinished uploads. */
export async function scanUserPrefix(store: DeletionObjectStore, userId: string, now = () => new Date()): Promise<ScanResult> {
  const startedAt = now();
  const prefix = userPrefix(store.keyPrefix, userId);
  let objects = 0;
  let uploads = 0;
  const sampleKeys: string[] = [];
  try {
    let token: string | undefined;
    do {
      const page = await store.listObjects(prefix, token);
      objects += page.keys.length;
      for (const k of page.keys) if (sampleKeys.length < 5) sampleKeys.push(k);
      token = page.next;
    } while (token);
    let marker: { key: string; uploadId: string } | undefined;
    do {
      const page = await store.listUploads(prefix, marker);
      uploads += page.uploads.length;
      marker = page.next;
    } while (marker);
  } catch (err) {
    return { complete: false, startedAt, objects, uploads, sampleKeys, error: errText(err) };
  }
  return { complete: true, startedAt, objects, uploads, sampleKeys };
}

/**
 * Does this scan verify the prefix empty? Only a complete scan that STARTED
 * after T_last, and found nothing, does.
 */
export function scanVerifies(scan: ScanResult, tLast: Date | null): boolean {
  if (!scan.complete || !tLast) return false;
  return scan.startedAt.getTime() > tLast.getTime() && scan.objects === 0 && scan.uploads === 0;
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return status ? `${err.name}: ${err.message} (HTTP ${status})` : `${err.name}: ${err.message}`;
  }
  return String(err);
}

// ── S3 adapter ────────────────────────────────────────────────────────

export function s3DeletionStore(cfg: AttachmentCacheConfig): DeletionObjectStore {
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Same Spaces compatibility settings as attachments/s3-storage.ts.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // Bounded, so a hung request fails the step instead of hanging the command.
    requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 },
  });
  return {
    keyPrefix: cfg.prefix,
    async listObjects(prefix, token) {
      const out = await client.send(
        new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (out.Contents ?? []).map((c) => c.Key).filter((k): k is string => !!k);
      if (out.IsTruncated && !out.NextContinuationToken) {
        throw new Error("listing truncated without a continuation token");
      }
      return { keys, next: out.IsTruncated ? out.NextContinuationToken : undefined };
    },
    async listUploads(prefix, marker) {
      const out = await client.send(
        new ListMultipartUploadsCommand({
          Bucket: cfg.bucket,
          Prefix: prefix,
          KeyMarker: marker?.key,
          UploadIdMarker: marker?.uploadId,
        }),
      );
      const uploads = (out.Uploads ?? [])
        .filter((u) => u.Key && u.UploadId)
        .map((u) => ({ key: u.Key!, uploadId: u.UploadId! }));
      if (out.IsTruncated && !(out.NextKeyMarker && out.NextUploadIdMarker)) {
        throw new Error("multipart listing truncated without markers");
      }
      return {
        uploads,
        next: out.IsTruncated ? { key: out.NextKeyMarker!, uploadId: out.NextUploadIdMarker! } : undefined,
      };
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
    async abortUpload(key, uploadId) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId }));
    },
  };
}

/**
 * The store to purge, or null when it can't be reached from here.
 *
 * NOT gated on ATTACHMENT_CACHE_ENABLED. A cache that was on last month and is
 * off today still holds last month's objects, so "the flag is off" must never
 * read as "there is nothing to delete". With the flag off, the same six
 * variables are read directly; if any is missing the caller gets null and the
 * storage step FAILS — it is not skipped.
 */
export function resolveDeletionStore(): DeletionObjectStore | null {
  const cfg = resolveAttachmentCacheConfig() ?? readStorageEnv();
  return cfg ? s3DeletionStore(cfg) : null;
}

function readStorageEnv(): AttachmentCacheConfig | null {
  const e = process.env;
  const cfg = {
    endpoint: e.OBJECT_STORAGE_ENDPOINT?.trim() ?? "",
    region: e.OBJECT_STORAGE_REGION?.trim() ?? "",
    bucket: e.OBJECT_STORAGE_BUCKET?.trim() ?? "",
    accessKeyId: e.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() ?? "",
    secretAccessKey: e.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() ?? "",
    prefix: e.OBJECT_STORAGE_PREFIX ?? "",
  };
  if (Object.values(cfg).some((v) => !v)) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cfg.prefix)) return null;
  return cfg;
}
