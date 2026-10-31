/**
 * A minimal S3 over HTTP, in-process, for the account-deletion tests.
 *
 * It exists so the real adapters — `s3DeletionStore` and `resolveLedger` —
 * run through the real AWS SDK: request signing, path-style addressing,
 * continuation tokens and multipart markers, XML parsing, HTTP error mapping.
 * The in-memory fakes in storage.test.ts can't catch a bug in any of those.
 *
 * Implements only what deletion calls: ListObjectsV2, ListMultipartUploads,
 * DeleteObject, AbortMultipartUpload, PutObject, GetObject. Listings page at
 * `pageSize` so pagination is always exercised. Failures are injected per key
 * or per operation. It is NOT DigitalOcean Spaces; the real-service checks
 * (Phase 0 steps 7a–7k) stay pending.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  objects: Map<string, Buffer>;
  uploads: { key: string; uploadId: string }[];
  pageSize: number;
  /** Requests seen, as "METHOD op key". */
  log: string[];
  fail: {
    deleteKeys: Set<string>;
    list: boolean;
    uploadList: boolean;
    /** Answer IsTruncated=true with no continuation token. */
    truncatedWithoutToken: boolean;
    put: boolean;
    /** GetObject returns a different body than was written. */
    corruptGet: boolean;
  };
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;

const errorXml = (code: string, message: string) => xml(`<Error><Code>${code}</Code><Message>${esc(message)}</Message></Error>`);

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

export async function startFakeS3(bucket = "deletion-test"): Promise<FakeS3> {
  const s3: FakeS3 = {
    endpoint: "",
    close: async () => undefined,
    bucket,
    objects: new Map(),
    uploads: [],
    pageSize: 3,
    log: [],
    fail: { deleteKeys: new Set(), list: false, uploadList: false, truncatedWithoutToken: false, put: false, corruptGet: false },
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const [, b, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const q = url.searchParams;
    const send = (status: number, body = "", type = "application/xml") => {
      res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    const deny = (what: string) => send(403, errorXml("AccessDenied", `injected failure: ${what}`));

    if (b !== s3.bucket) return send(404, errorXml("NoSuchBucket", `no bucket ${b}`));

    // ── Bucket-level: listings ──
    if (req.method === "GET" && !key) {
      if (q.has("uploads")) {
        s3.log.push(`GET ListMultipartUploads ${q.get("prefix")}`);
        if (s3.fail.uploadList) return deny("multipart listing");
        const prefix = q.get("prefix") ?? "";
        const all = s3.uploads.filter((u) => u.key.startsWith(prefix)).sort((x, y) => (x.key + x.uploadId).localeCompare(y.key + y.uploadId));
        const km = q.get("key-marker");
        const um = q.get("upload-id-marker");
        const start = km ? all.findIndex((u) => u.key === km && u.uploadId === um) + 1 : 0;
        const page = all.slice(start, start + s3.pageSize);
        const truncated = start + s3.pageSize < all.length;
        const last = page[page.length - 1];
        return send(
          200,
          xml(
            `<ListMultipartUploadsResult><Bucket>${s3.bucket}</Bucket><Prefix>${esc(prefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>` +
              (truncated && last ? `<NextKeyMarker>${esc(last.key)}</NextKeyMarker><NextUploadIdMarker>${last.uploadId}</NextUploadIdMarker>` : "") +
              page.map((u) => `<Upload><Key>${esc(u.key)}</Key><UploadId>${u.uploadId}</UploadId></Upload>`).join("") +
              `</ListMultipartUploadsResult>`,
          ),
        );
      }
      s3.log.push(`GET ListObjectsV2 ${q.get("prefix")}`);
      if (s3.fail.list) return deny("listing");
      const prefix = q.get("prefix") ?? "";
      const all = [...s3.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const token = q.get("continuation-token");
      const start = token ? Number(token) : 0;
      const page = all.slice(start, start + s3.pageSize);
      const truncated = start + s3.pageSize < all.length;
      const next = truncated && !s3.fail.truncatedWithoutToken ? `<NextContinuationToken>${start + s3.pageSize}</NextContinuationToken>` : "";
      return send(
        200,
        xml(
          `<ListBucketResult><Name>${s3.bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${s3.pageSize}</MaxKeys>` +
            `<IsTruncated>${truncated}</IsTruncated>${next}` +
            page.map((k) => `<Contents><Key>${esc(k)}</Key><Size>${s3.objects.get(k)!.byteLength}</Size></Contents>`).join("") +
            `</ListBucketResult>`,
        ),
      );
    }

    // ── Object-level ──
    if (req.method === "DELETE" && q.has("uploadId")) {
      s3.log.push(`DELETE AbortMultipartUpload ${key}`);
      const i = s3.uploads.findIndex((u) => u.key === key && u.uploadId === q.get("uploadId"));
      if (i < 0) return send(404, errorXml("NoSuchUpload", "no such upload"));
      s3.uploads.splice(i, 1);
      return send(204);
    }
    if (req.method === "DELETE") {
      s3.log.push(`DELETE DeleteObject ${key}`);
      if (s3.fail.deleteKeys.has(key)) return deny(`delete ${key}`);
      s3.objects.delete(key); // S3 answers 204 for a missing key too
      return send(204);
    }
    if (req.method === "PUT") {
      const body = await readBody(req);
      s3.log.push(`PUT PutObject ${key}`);
      if (s3.fail.put) return deny(`put ${key}`);
      s3.objects.set(key, body);
      res.writeHead(200, { etag: `"${body.byteLength}"` });
      return res.end();
    }
    if (req.method === "GET") {
      s3.log.push(`GET GetObject ${key}`);
      const obj = s3.objects.get(key);
      if (!obj) return send(404, errorXml("NoSuchKey", `no key ${key}`));
      const out = s3.fail.corruptGet ? Buffer.from(`${obj.toString()} `) : obj;
      res.writeHead(200, { "content-type": "application/json", "content-length": out.byteLength });
      return res.end(out);
    }
    send(405, errorXml("MethodNotAllowed", `${req.method} ${url.pathname}`));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // An IP endpoint makes the SDK use path-style addressing, as with Spaces' fixed endpoint.
  s3.endpoint = `http://127.0.0.1:${port}`;
  s3.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return s3;
}
