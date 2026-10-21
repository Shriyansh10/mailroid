import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { rateLimiter } from "@repo/ai";
import {
  getAttachmentBytes,
  AttachmentBusyError,
  AttachmentTooLargeError,
  StorageUnavailableError,
} from "@repo/services/attachments/index";
import {
  buildAttachmentHeaders,
  resolveDisposition,
  MAGIC_SNIFF_BYTES,
} from "@repo/services/attachments/headers";
import { logger } from "@repo/logger";

/**
 * Attachment bytes, one request at a time.
 *
 * A Next route handler rather than tRPC, which is JSON-only here, and not
 * apps/api, whose `express.json()` has no `limit` set. It is the first route in
 * this app to return binary rather than `NextResponse.json`.
 *
 * `[id]` is our own `message_attachments.id`, never Gmail's ids. An opaque,
 * server-owned uuid means the URL cannot be hand-assembled to probe arbitrary
 * Gmail objects, and ownership is one indexed lookup rather than a trust
 * decision about two attacker-supplied strings.
 *
 * `?download=1` forces a download; otherwise a narrow allowlist of types may
 * render inline. See headers.ts — that decision is never taken on the sender's
 * word about what the file is.
 */
export const runtime = "nodejs";

/** Not statically renderable, and must never be cached at the framework level. */
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // Before any work. `check()` increments as a side effect, so calling it
    // after a fetch would let a burst through and only then start counting.
    // This is a fairness control as much as an abuse one: Gmail's
    // attachments.get costs 20 quota units against the *project*, so one
    // account hammering it degrades Gmail for every user.
    const limit = rateLimiter.check(userId, "fetchAttachment");
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many attachment downloads. Try again shortly." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))),
          },
        },
      );
    }

    const payload = await getAttachmentBytes(userId, id);

    // Null covers BOTH "no such attachment" and "not yours", and the route
    // cannot tell them apart. That is deliberate: a 403 would confirm the id
    // exists, which is exactly the enumeration oracle the opaque id closes.
    if (!payload) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const wantInline = new URL(request.url).searchParams.get("download") !== "1";
    const { record } = payload;

    // Always a stream from object storage — the only read source. This route
    // never talks to Gmail: a confirmed miss was already handed to the API (the
    // only Gmail reader), which stored the object before we read it back.
    //
    // There is no Buffer to inspect, and buffering one to sniff it would throw
    // away the reason streaming is cheap. So: read exactly one chunk, decide
    // from its first bytes, then re-emit that chunk ahead of the rest. Peak
    // stays at one chunk rather than the whole file.
    const reader = payload.body.getReader();
    const first = await reader.read();
    const head = first.value ? first.value.subarray(0, MAGIC_SNIFF_BYTES) : new Uint8Array();
    const { disposition, contentType } = resolveDisposition(record.mimeType, head, wantInline);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.value) controller.enqueue(first.value);
        if (first.done) controller.close();
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      },
      cancel(reason) {
        // Propagated so an aborted download returns the underlying socket to
        // the pool instead of leaking it for the request's lifetime.
        void reader.cancel(reason);
      },
    });

    return new Response(stream, {
      headers: buildAttachmentHeaders({
        disposition,
        contentType,
        filename: record.filename,
        contentLength: payload.contentLength,
      }),
    });
  } catch (err) {
    if (err instanceof AttachmentTooLargeError) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    if (err instanceof AttachmentBusyError) {
      return NextResponse.json(
        { error: err.message },
        { status: 503, headers: { "Retry-After": String(err.retryAfterSeconds) } },
      );
    }
    // Storage down or unconfigured: fail closed. Never a fallback to Gmail —
    // that fallback is exactly what turned outages into download storms.
    if (err instanceof StorageUnavailableError) {
      return NextResponse.json(
        { error: err.message },
        { status: 503, headers: { "Retry-After": String(err.retryAfterSeconds) } },
      );
    }

    // An upstream status is worth passing through rather than flattening to
    // 500: a 429 tells the client to back off, and a 404 means the attachment
    // is genuinely gone from the message rather than that we broke.
    const status = (err as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      logger.warn("[ATTACHMENTS] upstream refused", { attachmentId: id, status });
      return NextResponse.json(
        { error: status === 404 ? "This attachment is no longer available in Gmail." : "Could not fetch attachment." },
        { status },
      );
    }

    logger.error("[ATTACHMENTS] route failed", { attachmentId: id, error: String(err) });
    return NextResponse.json({ error: "Could not fetch attachment." }, { status: 500 });
  }
}
