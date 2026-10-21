/**
 * Client for the multipart send route.
 *
 * Used only when a message actually carries files. Text-only mail keeps going
 * through the tRPC mutations exactly as before — that path is the product's
 * main outbound route and is deliberately left untouched.
 */

export interface SendWithAttachmentsResult {
  id?: string;
  threadId?: string;
  /** Returned by the two draft modes instead of a message id. */
  draftId?: string;
}

export type ComposeMode = "new" | "reply" | "forward" | "draft-create" | "draft-update";

export interface SendWithAttachmentsInput {
  mode: ComposeMode;
  files: File[];
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body: string;
  /** Reply and forward target — the Gmail message being responded to. */
  entityId?: string;
  replyAll?: boolean;
  threadId?: string;
  /** The draft being updated, for mode "draft-update". */
  draftId?: string;
  /**
   * Ids of attachments already on the draft that should survive this write.
   *
   * `undefined` means "keep whatever is there" — the right default for a caller
   * that is not managing attachments. An empty array means "remove them all",
   * which is a real request and must be distinguishable from silence, because
   * Gmail's draft update replaces the entire message either way.
   */
  keepAttachmentIds?: string[];
}

export async function sendWithAttachments(
  input: SendWithAttachmentsInput,
): Promise<SendWithAttachmentsResult> {
  const form = new FormData();
  form.set("mode", input.mode);
  form.set("body", input.body);

  // Only non-empty values are appended. An empty `cc` must mean "no Cc" rather
  // than an empty Cc header — the same distinction replyToEmail's override
  // semantics depend on server-side.
  for (const key of ["to", "cc", "bcc", "subject", "entityId", "threadId", "draftId"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) form.set(key, value.trim());
  }
  if (input.replyAll) form.set("replyAll", "true");

  // Only when the caller actually has an opinion. Sending "[]" by default would
  // strip every attachment from any draft written by a caller that simply did
  // not think about them.
  if (input.keepAttachmentIds !== undefined) {
    form.set("keepAttachmentIds", JSON.stringify(input.keepAttachmentIds));
  }

  for (const file of input.files) form.append("attachments", file, file.name);

  const response = await fetch("/api/compose/send", { method: "POST", body: form });

  if (!response.ok) {
    // The server writes these messages for a person to read — a size or
    // blocked-type refusal names the number or the extension. Replacing them
    // with a generic string here would throw away the only actionable part.
    const detail = await response
      .json()
      .then((json: { error?: string }) => json?.error)
      .catch(() => undefined);
    throw new Error(detail || "Could not send the message.");
  }

  return (await response.json()) as SendWithAttachmentsResult;
}
