/**
 * Sending a message whose MIME is too large for the plugin.
 *
 * WHY THIS EXISTS AT ALL. `tenant.gmail.api.messages.send({ raw })` posts to
 * `/gmail/v1/users/me/messages/send`, the NON-upload endpoint, whose request
 * body is capped at 5 MB. Gmail's real per-message ceiling is 25 MB, reachable
 * only through `/upload/gmail/v1/...?uploadType=media`, and the Corsair plugin
 * has no way to express that. So this is a raw REST call against the same
 * credentials — the established bypass, identical in shape to the one
 * attachments/gmail-fetch.ts uses for `messages.attachments.get`.
 *
 * A message with no attachments never comes here. Those keep going through the
 * plugin exactly as they always have, because a text-only body cannot approach
 * 5 MB and rerouting the product's entire outbound path to exercise one branch
 * would be the riskiest possible way to add a feature.
 */
import { randomBytes } from "node:crypto";

import { corsair } from "@repo/corsair";
import { logger } from "@repo/logger";

import { GmailHttpError } from "../attachments/gmail-fetch.ts";
import { withGmailRetry } from "./retry.ts";

const GMAIL_UPLOAD_BASE = "https://gmail.googleapis.com/upload/gmail/v1/users/me";

export interface RawSendResult {
  id: string;
  threadId: string;
}

/**
 * `keys.get_access_token()` DECRYPTS the stored token; it does not refresh it.
 * Refresh happens only through the plugin's keyBuilder on an SDK `api.*` call,
 * which is why the 401 recovery below makes a throwaway SDK call rather than
 * asking for the token again and getting the same expired one back.
 */
async function readToken(tenantId: string): Promise<string> {
  const token = await corsair.withTenant(tenantId).gmail.keys.get_access_token();
  if (!token) {
    throw new GmailHttpError(401, "No Gmail access token available for this account.");
  }
  return token;
}

/**
 * Send or draft a message from its raw MIME, via the upload endpoint.
 *
 * `raw` is base64url as produced by buildRawEmail. It is decoded back to bytes
 * here because the upload endpoint takes `message/rfc822` directly rather than
 * a JSON envelope — which is also what keeps this path off the 5 MB limit,
 * since there is no base64-inside-JSON inflation on the wire.
 */
export async function sendRawMessage(
  tenantId: string,
  raw: string,
  options: {
    threadId?: string;
    asDraft?: boolean;
    /**
     * Update an existing draft rather than creating one.
     *
     * Gmail has no partial draft update — `drafts.update` REPLACES the whole
     * message — so a caller using this must supply every part it wants the
     * draft to keep, not just the ones that changed.
     */
    draftId?: string;
  } = {},
): Promise<RawSendResult> {
  const mime = Buffer.from(raw, "base64url");

  // `multipart`, not `media`, and the difference is load-bearing.
  //
  // `uploadType=media` sends the MIME as the whole request body, which leaves
  // NOWHERE to put `threadId`. That parameter is Gmail's own grouping hint —
  // In-Reply-To/References thread the message for every other client, but
  // Gmail's UI uses threadId, so dropping it would make a reply carrying an
  // attachment appear in Gmail as a brand-new conversation rather than in the
  // thread the user replied from. `multipart` carries a JSON metadata part
  // alongside the message, which is where threadId goes.
  //
  // `resumable` is the third option and is not used: it costs a session round
  // trip and buys nothing below 25 MB, which is the hard ceiling regardless.
  const isDraft = options.asDraft || !!options.draftId;
  const metadata = isDraft
    ? { message: options.threadId ? { threadId: options.threadId } : {} }
    : options.threadId
      ? { threadId: options.threadId }
      : {};

  const boundary = `mailroid_upload_${randomBytes(16).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: message/rfc822\r\n\r\n`,
      "utf-8",
    ),
    mime,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"),
  ]);

  // The real operation, so the pacer charges its real price (a draft write is
  // 15 units, a send 100) and the ledger names what happened. And `tenantId`,
  // ALWAYS: without it withGmailRetry skips the cooldown gate, the mailbox
  // semaphore and the 429 → cooldown recording, which is how uploads used to
  // reach Gmail outside every per-mailbox control as "unattributed".
  const operation = options.draftId ? "drafts.update" : options.asDraft ? "drafts.create" : "messages.send";
  return withGmailRetry(`${operation} (upload, ${mime.byteLength} bytes)`, async () => {
    let token = await readToken(tenantId);
    let refreshedToken = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      const path = options.draftId
        ? `drafts/${encodeURIComponent(options.draftId)}`
        : options.asDraft
          ? "drafts"
          : "messages/send";
      const url = new URL(`${GMAIL_UPLOAD_BASE}/${path}`);
      url.searchParams.set("uploadType", "multipart");

      const response = await fetch(url.toString(), {
        // PUT replaces the draft in place; POST would create a second one and
        // leave the original behind, which the user would then see twice.
        method: options.draftId ? "PUT" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
          // Explicit, so the transport never falls back to chunked framing for
          // a body this size.
          "Content-Length": String(body.byteLength),
        },
        body: new Uint8Array(body),
      });

      if (response.status === 401 && !refreshedToken) {
        // Force the plugin to refresh, then re-read the decrypted token.
        refreshedToken = true;
        await corsair
          .withTenant(tenantId)
          .gmail.api.messages.list({ maxResults: 1 })
          .catch(() => undefined);
        token = await readToken(tenantId);
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        // Status attached, always. withGmailRetry treats an error with no
        // numeric status as retryable, so a bare Error here would retry a 400
        // four times and, on a 429, renew the very block it should back off
        // from.
        throw new GmailHttpError(
          response.status,
          `Gmail upload send failed with ${response.status}: ${body.slice(0, 500)}`,
          body,
        );
      }

      const json = (await response.json()) as {
        id?: string;
        threadId?: string;
        message?: { id?: string; threadId?: string };
      };

      // A draft response nests the message; a send response does not.
      const message = isDraft ? (json.message ?? {}) : json;

      logger.info("[SERVICE] raw MIME sent via upload endpoint", {
        tenantId,
        bytes: mime.byteLength,
        asDraft: isDraft,
        messageId: message.id,
      });

      return {
        id: (isDraft ? json.id : message.id) ?? "",
        threadId: message.threadId ?? "",
      };
    }

    throw new GmailHttpError(401, "Gmail rejected the upload send after a token refresh.");
  }, { tenantId, trigger: isDraft ? "ui" : "send" });
}
