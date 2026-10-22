import { FORWARD_ATTACHMENTS_UNAVAILABLE } from "@repo/services/gmail/attachment-limits";

/**
 * Did a forward fail because the original's files could not be carried — the
 * failure that guarantees nothing was sent?
 *
 * Two transports, one meaning: the multipart route answers with the code
 * itself (SendRouteError.code), and the tRPC procedure maps it to
 * PRECONDITION_FAILED, which it uses for nothing else (see the gmail router).
 */
export function isForwardAttachmentsUnavailable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code === FORWARD_ATTACHMENTS_UNAVAILABLE) return true;
  return (err as { data?: { code?: unknown } }).data?.code === "PRECONDITION_FAILED";
}
