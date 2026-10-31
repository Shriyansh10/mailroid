/**
 * The S3-compatible object storage adapter.
 *
 * Named for the protocol rather than the vendor. The store behind it is
 * DigitalOcean Spaces; nothing outside this file knows that, and nothing outside
 * this file imports `@aws-sdk/client-s3`. Swapping providers is an env change.
 *
 * This is a CACHE ADAPTER, and the distinction shapes every decision below. Gmail
 * owns the bytes. Everything here is disposable: a failure is a cache miss, a
 * missing object is a cache miss, and losing the entire bucket costs latency and
 * nothing else. The read path in `index.ts` is written to treat it that way, so
 * this file's job is to report absence and failure honestly rather than to try
 * heroically to succeed.
 *
 * No object here is ever reachable by URL. Keys are server-owned and the browser
 * only ever sees `/api/attachments/{id}`, behind the ownership check. No presigned
 * URL is minted, and no ACL is ever set — Spaces objects default to private, and
 * `public-read` would publish every cached attachment at a guessable address.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

import type { AttachmentCacheConfig } from "./config.ts";
import type { ObjectStorage } from "./types.ts";

/**
 * Is this error the store saying "no such object"?
 *
 * Status code FIRST, name second. The SDK's error names are not stable across
 * operations for the same underlying condition — `GetObject` throws `NoSuchKey`
 * while `HeadObject` throws `NotFound` for exactly the same missing object — and
 * S3-compatible providers are not obliged to agree with AWS on either. The HTTP
 * status is the part every implementation gets right.
 */
function isNotFound(err: unknown): boolean {
  const e = err as { $metadata?: { httpStatusCode?: number }; name?: string };
  if (e?.$metadata?.httpStatusCode === 404) return true;
  return e?.name === "NoSuchKey" || e?.name === "NotFound";
}

export function s3Storage(cfg: AttachmentCacheConfig): ObjectStorage {
  const client = new S3Client({
    // A real region, not "auto". Spaces uses genuine region slugs ("sgp1") and
    // SigV4 signs over the region, so a wrong value fails as a signature error.
    region: cfg.region,
    // The REGIONAL host (https://sgp1.digitaloceanspaces.com), never the bucket
    // host — the SDK prepends the bucket itself. `forcePathStyle` is deliberately
    // left unset; add it only if DNS for the virtual-hosted form misbehaves.
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // S3-COMPATIBILITY — NOT OPTIONAL, AND THE FIRST THING TO CHECK IF UPLOADS
    // START FAILING AFTER A DEPENDENCY BUMP.
    //
    // Since ~3.729 the SDK defaults both of these to "WHEN_SUPPORTED", which
    // makes it send `x-amz-checksum-crc32` and switch the body to `aws-chunked`
    // framing. Spaces rejects that, and it rejects it with an error that reads
    // like a credentials problem rather than a protocol one — which is what makes
    // this cost an afternoon rather than a minute. Only a real PutObject against
    // real Spaces proves this is still right; a mocked test cannot.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  return {
    enabled: true,
    keyPrefix: cfg.prefix,

    async getObject(key) {
      try {
        const out = await client.send(
          new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
        );
        if (!out.Body) return null;

        return {
          // The contract in types.ts is a WEB ReadableStream, because that is
          // what the route hands to `new Response(...)`. The SDK's native shape
          // is a Node Readable, and all of that plumbing stays inside this
          // adapter — the caller must never learn which SDK produced the bytes.
          stream: out.Body.transformToWebStream(),
          contentLength: out.ContentLength,
        };
      } catch (err) {
        // Absence is a normal, expected outcome: an evicted object, or a pointer
        // written by a deploy whose bucket has since been emptied. `null` sends
        // the caller down the Gmail path, which is exactly right. Every other
        // error propagates — the caller logs it and ALSO falls back, so a real
        // outage degrades to "slower", never to a 5xx.
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async putObject(key, body, opts) {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          // ALWAYS a Buffer, never a stream. With a Buffer the SDK can infer
          // ContentLength; a stream without one falls back to `aws-chunked`
          // framing, which is the same incompatibility the checksum options
          // above exist to avoid. No `@aws-sdk/lib-storage` either — a single
          // PutObject handles 5 GB and our ceiling is 25 MB.
          Body: body,
          ContentLength: body.byteLength,
          ContentType: opts.contentType,
          // NO `ACL`. Not "ACL: private" — absent entirely. Spaces defaults to
          // private, and the only reason to name this field is to weaken it.
        }),
      );
    },

    async deleteObject(key) {
      // Deliberately does NOT swallow 404, and this is the opposite of the
      // getObject rule above.
      //
      // S3 delete is idempotent: removing a key that is not there returns 204,
      // not an error. So a 404 here cannot mean "already gone" — it means
      // NoSuchBucket, i.e. the bucket name is wrong or the key has no access to
      // it. Treating that as success would make the eviction sweep report
      // thousands of cheerful deletions while freeing nothing at all, and the
      // pointers would be cleared behind it.
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },

    async headObject(key) {
      try {
        const out = await client.send(
          new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }),
        );
        return { contentLength: out.ContentLength ?? 0 };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
  };
}
