import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { rateLimiter } from "@repo/ai";
import { sendEmail, replyToEmail, forwardEmail } from "@repo/services/gmail/index";
import { createDraft, updateDraft } from "@repo/services/gmail/drafts";
import {
  MAX_UPLOAD_BYTES,
  MAX_TOTAL_RAW_BYTES,
  MAX_ATTACHMENT_COUNT,
  validateOutgoingAttachments,
} from "@repo/services/gmail/attachment-limits";
import { admitUpload, AttachmentBusyError } from "@repo/services/attachments/index";
import { getGlobalMaintenance } from "@repo/services/gmail/pause";
import { logger } from "@repo/logger";

/**
 * Sending a message that carries attachments.
 *
 * A Next route handler rather than tRPC because tRPC here is JSON-only, and
 * because apps/api's `express.json()` has no `limit` set — the same two reasons
 * the attachment READ route lives in this app. Only the transport is new: this
 * calls the same sendEmail / replyToEmail / forwardEmail service functions the
 * tRPC routes call, so there is one implementation of sending, reached two ways.
 *
 * TEXT-ONLY MAIL NEVER COMES HERE. It keeps using tRPC exactly as before, which
 * is what makes a regression on the product's main outbound path impossible by
 * construction rather than by test coverage.
 *
 * Needs its own Caddyfile block above the `/api/*` catch-all, since that
 * catch-all routes to the API container.
 *
 * ALSO EXCLUDED FROM proxy.ts's matcher, which is why the maintenance check
 * below is written out by hand here. Running proxy on this route made Next
 * buffer and then TRUNCATE the upload at 10 MB, which broke every attachment
 * over that size — the full reasoning is on `config` at the bottom of
 * apps/web/proxy.ts. The two must be changed together.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Marker so a size abort is distinguishable from a genuine parse failure. */
class UploadTooLargeError extends Error {
  readonly tooLarge = true;
}

/**
 * Bound the request body WHILE it arrives.
 *
 * THE ORDER IS THE WHOLE POINT. `await request.formData()` materialises the
 * entire body before returning, so any validation written after it has already
 * lost — a 500 MB POST is 500 MB of resident memory on a 512m container with no
 * swap, and the OOM killer picks its own victim, most likely Postgres. Next 16
 * offers no body limit of its own (`bodySizeLimit` is Pages-API config and does
 * not apply to route handlers).
 *
 * So the stream is counted and errored past the cap, then a NEW Request is
 * built around the bounded stream and `.formData()` is called on that. The
 * platform parser still does the parsing; peak memory becomes the cap rather
 * than whatever the client chose to send.
 */
function boundBody(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          controller.error(new UploadTooLargeError(`Upload exceeded ${limit} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * The byte cap was hit while the body was still arriving.
 *
 * Phrased from MAX_TOTAL_RAW_BYTES rather than from MAX_UPLOAD_BYTES, which is
 * the number actually enforced: the extra megabyte in the upload cap is
 * headroom for field names, boundaries and the message text, and quoting it to
 * a user would advertise an attachment allowance that validation then refuses.
 * The attachment limit is the only figure they can act on.
 */
function tooLarge(): NextResponse {
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return NextResponse.json(
    {
      error:
        `That message is too large to send. Gmail allows up to ` +
        `${mb(MAX_TOTAL_RAW_BYTES)} of attachments per email.`,
    },
    { status: 413 },
  );
}

export async function POST(request: Request) {
  let release: (() => void) | null = null;

  try {
    // The gate proxy.ts applies to every other route, restored here because
    // this one is excluded from its matcher (see the header). Deliberately
    // BEFORE auth, matching proxy's own ordering: during maintenance there is
    // nothing behind the gate worth authenticating for.
    //
    // A JSON 503 rather than proxy's rewrite to /maintenance, and that is an
    // improvement rather than a divergence: the rewrite answers a fetch() that
    // is expecting JSON with an HTML page, which surfaces to the sender as a
    // parse error instead of "we are down for maintenance".
    //
    // Fails OPEN, exactly as all three checks in proxy.ts do. Refusing to send
    // a user's mail because one DB read failed would make this switch more
    // dangerous than the outages it exists to manage.
    try {
      if (await getGlobalMaintenance()) {
        return NextResponse.json(
          { error: "Mailroid is down for maintenance. Your message has not been sent." },
          { status: 503 },
        );
      }
    } catch (err) {
      logger.error("[COMPOSE] maintenance check failed, allowing send", { error: String(err) });
    }

    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // Before any body is read. `check()` increments as a side effect, so
    // calling it later would let a burst through and only then start counting.
    const limit = rateLimiter.check(userId, "sendEmail");
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "You have sent a lot of mail recently. Try again shortly." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))),
          },
        },
      );
    }

    // Cheap gate first: an honest client announcing an over-limit body is
    // refused without reading a byte. Never the actual bound — it is
    // client-supplied and absent entirely under chunked encoding, which is why
    // the counting stream below exists and is what the test must exercise.
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      logger.warn("[COMPOSE] refused on declared Content-Length", { userId, declared });
      return tooLarge();
    }

    if (!request.body) {
      return NextResponse.json({ error: "Expected a multipart form body." }, { status: 400 });
    }

    let form: FormData;
    try {
      const bounded = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: boundBody(request.body, MAX_UPLOAD_BYTES),
        // Required by undici to stream a request body; not yet in the DOM lib
        // types, hence the cast rather than a lint suppression.
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      form = await bounded.formData();
    } catch (err) {
      if (err instanceof UploadTooLargeError || (err as { cause?: unknown })?.cause instanceof UploadTooLargeError) {
        logger.warn("[COMPOSE] refused mid-upload on the byte cap", { userId });
        return tooLarge();
      }
      logger.warn("[COMPOSE] malformed multipart body", { userId, error: String(err) });
      return NextResponse.json({ error: "Could not read the form data." }, { status: 400 });
    }

    const mode = String(form.get("mode") ?? "new");
    const files = form.getAll("attachments").filter((f): f is File => f instanceof File);

    /**
     * Ids of attachments ALREADY on the draft that should survive this write.
     *
     * Sent as a field rather than inferred, because Gmail's drafts.update
     * replaces the whole message: silence here cannot mean "keep them" and
     * "drop them" at the same time. Absent entirely = keep everything, which is
     * what a caller that knows nothing about attachments must get.
     *
     * Carried as ONE JSON field rather than repeated form entries, because
     * `getAll` returns [] both for "the client sent an empty list" and for "the
     * client never mentioned it" — and those must mean opposite things here.
     */
    let keepAttachmentIds: string[] | undefined;
    const keepRaw = form.get("keepAttachmentIds");
    if (typeof keepRaw === "string") {
      try {
        const parsed: unknown = JSON.parse(keepRaw);
        if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string")) {
          return NextResponse.json({ error: "Malformed keepAttachmentIds." }, { status: 400 });
        }
        keepAttachmentIds = parsed as string[];
      } catch {
        return NextResponse.json({ error: "Malformed keepAttachmentIds." }, { status: 400 });
      }
    }

    if (files.length > MAX_ATTACHMENT_COUNT) {
      return NextResponse.json(
        { error: `You can attach up to ${MAX_ATTACHMENT_COUNT} files to one message.` },
        { status: 400 },
      );
    }

    const body = String(form.get("body") ?? "");

    // Validated from the declared sizes BEFORE any buffer is materialised, so
    // an over-limit set costs nothing to refuse. The sum is what is checked,
    // never each file alone — three 8 MB files each pass individually.
    const verdict = validateOutgoingAttachments(
      files.map((f) => ({ filename: f.name, sizeBytes: f.size })),
      Buffer.byteLength(body, "utf-8"),
    );
    if (!verdict.ok) {
      logger.info("[COMPOSE] rejected before any Gmail call", { userId, code: verdict.code });
      return NextResponse.json({ error: verdict.reason }, { status: 413 });
    }

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

    // Charged against this (web) container's upload budget — see admitUpload;
    // Gmail downloads now run in the API container on their own budget. Released
    // in `finally`, never earlier: the Buffers below stay alive until the Gmail
    // call returns, so releasing at response time would bound nothing.
    release = admitUpload(userId, totalBytes);

    const attachments = await Promise.all(
      files.map(async (file) => ({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        content: Buffer.from(await file.arrayBuffer()),
      })),
    );

    const str = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };

    let result: { id: string; threadId: string };

    switch (mode) {
      // Draft writes return a DRAFT id, not a message id. The compose box needs
      // that id to update the same draft next time rather than creating a new
      // one on every save.
      case "draft-create": {
        const created = await createDraft(
          userId,
          {
            to: String(form.get("to") ?? ""),
            subject: String(form.get("subject") ?? ""),
            body,
            cc: str("cc"),
            bcc: str("bcc"),
            threadId: str("threadId"),
            entityId: str("entityId"),
            replyAll: form.get("replyAll") === "true",
          },
          attachments,
        );
        return NextResponse.json({ draftId: created.draftId });
      }

      case "draft-update": {
        const updated = await updateDraft(
          userId,
          String(form.get("draftId") ?? ""),
          {
            to: String(form.get("to") ?? ""),
            subject: String(form.get("subject") ?? ""),
            body,
            cc: str("cc"),
            bcc: str("bcc"),
            threadId: str("threadId"),
            entityId: str("entityId"),
            replyAll: form.get("replyAll") === "true",
          },
          { attachments, keepAttachmentIds },
        );
        return NextResponse.json({ draftId: updated.draftId });
      }

      case "reply":
        result = await replyToEmail(
          userId,
          {
            entityId: String(form.get("entityId") ?? ""),
            body,
            replyAll: form.get("replyAll") === "true",
            cc: str("cc"),
            bcc: str("bcc"),
          },
          attachments,
        );
        break;

      case "forward":
        result = await forwardEmail(
          userId,
          {
            entityId: String(form.get("entityId") ?? ""),
            to: String(form.get("to") ?? ""),
            note: body || undefined,
            cc: str("cc"),
            bcc: str("bcc"),
          },
          attachments,
        );
        break;

      default:
        result = await sendEmail(
          userId,
          {
            to: String(form.get("to") ?? ""),
            subject: String(form.get("subject") ?? ""),
            body,
            cc: str("cc"),
            bcc: str("bcc"),
            threadId: str("threadId"),
          },
          attachments,
        );
    }

    logger.info("[COMPOSE] sent with attachments", {
      userId,
      mode,
      attachmentCount: attachments.length,
      totalBytes,
      messageId: result.id,
    });

    // No bytes are retained. Gmail now holds the message and its parts, and the
    // metadata row that lets the sent attachment be downloaded later arrives
    // through the ordinary sync path rather than being written here.
    return NextResponse.json({ id: result.id, threadId: result.threadId });
  } catch (err) {
    if (err instanceof AttachmentBusyError) {
      return NextResponse.json(
        { error: "The server is busy moving attachments. Try again in a moment." },
        { status: 503, headers: { "Retry-After": String(err.retryAfterSeconds) } },
      );
    }

    // A Gmail status is worth passing through rather than flattening to 500 —
    // a 400 from Gmail usually means it refused the message itself, and the
    // sender should be told that rather than "something went wrong".
    const status = (err as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      logger.warn("[COMPOSE] Gmail refused the message", { status, error: String(err) });
      return NextResponse.json(
        { error: "Gmail refused this message. Check the recipients and attachments." },
        { status },
      );
    }

    logger.error("[COMPOSE] send failed", { error: String(err) });
    return NextResponse.json({ error: "Could not send the message." }, { status: 500 });
  } finally {
    release?.();
  }
}
