import { randomUUID } from "node:crypto";

import { corsair } from "@repo/corsair";
import { db, eq, sql, and, or, ilike, gte, inArray } from "@repo/database";
import { emails } from "@repo/database/models/emails";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";
import { getProtectedConfig } from "../profile/index.ts";
import { matchProtectedSender, matchProtectedKeyword } from "@repo/shared";
import { partitionSearchResults } from "./model.ts";
import { deriveCategory, deriveFlags, upsertMessageMetadata } from "./sync-metadata.ts";
import type {
  ThreadSummary,
  ThreadListResult,
  ThreadDetail,
  MessageDetail,
  SendEmailInput,
  SendEmailResult,
  ReplyToEmailInput,
  ForwardEmailInput,
  SyncResult,
  EmailCount,
  LocalSearchResult,
  EmbedResult,
  PendingEmbeddingsCount,
} from "./model.ts";
import { createEmbedding, createEmbeddingsBatch, embedSearchQuery } from "@repo/ai";

// ── Helpers ──────────────────────────────────────────────────────────

interface PayloadHeader {
  name?: string;
  value?: string;
}

interface MessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  headers?: PayloadHeader[];
  parts?: MessagePart[];
}

/** Counts parts that are attachments (Gmail: a non-empty filename). */
function countAttachments(payload: MessagePart | undefined): number {
  if (!payload) return 0;
  let count = payload.filename ? 1 : 0;
  if (payload.parts) {
    for (const part of payload.parts) count += countAttachments(part);
  }
  return count;
}

/**
 * Extract a header value from payload.headers by name (case-insensitive).
 */
function getHeader(headers: PayloadHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const h = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

/**
 * Extract plain text body from a nested MIME payload.
 * Prefers text/plain, falls back to text/html with tags stripped.
 */
function extractBody(payload: MessagePart | undefined): string {
  if (!payload) return "";

  // Direct body on the part itself
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    if (payload.mimeType === "text/plain") return decoded;
    if (payload.mimeType === "text/html") return stripHtml(decoded);
  }

  // Recurse into sub-parts
  if (payload.parts) {
    // Prefer text/plain
    const plain = findPart(payload.parts, "text/plain");
    if (plain?.body?.data) {
      return Buffer.from(plain.body.data, "base64url").toString("utf-8");
    }
    // Fall back to text/html
    const html = findPart(payload.parts, "text/html");
    if (html?.body?.data) {
      return stripHtml(Buffer.from(html.body.data, "base64url").toString("utf-8"));
    }
  }

  return "";
}

/**
 * Extract the raw HTML body (base64url-decoded) — kept intact for
 * downstream sanitization (DOMPurify). Returns empty string if no
 * text/html part exists.
 */
function extractHtml(payload: MessagePart | undefined): string {
  if (!payload) return "";

  if (payload.body?.data && payload.mimeType === "text/html") {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  if (payload.parts) {
    const html = findPart(payload.parts, "text/html");
    if (html?.body?.data) {
      return Buffer.from(html.body.data, "base64url").toString("utf-8");
    }
  }

  return "";
}

function findPart(parts: MessagePart[], mimeType: string): MessagePart | undefined {
  for (const part of parts) {
    if (part.mimeType === mimeType) return part;
    if (part.parts) {
      const found = findPart(part.parts, mimeType);
      if (found) return found;
    }
  }
  return undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a base64url-encoded RFC 2822 email string for messages.send().
 *
 * `inReplyTo`/`references` are what make a reply thread correctly outside
 * Gmail's own UI — the `threadId` param on messages.send() is a Gmail-only
 * grouping hint that other mail clients ignore entirely, so a real reply
 * needs these headers regardless of whether Gmail's threadId is also set.
 */
function buildRawEmail(
  to: string,
  subject: string,
  body: string,
  extra?: { cc?: string; inReplyTo?: string; references?: string },
): string {
  const lines = [
    `To: ${to}`,
    extra?.cc ? `Cc: ${extra.cc}` : undefined,
    `Subject: ${subject}`,
    extra?.inReplyTo ? `In-Reply-To: ${extra.inReplyTo}` : undefined,
    extra?.references ? `References: ${extra.references}` : undefined,
    `Content-Type: text/plain; charset="UTF-8"`,
    `MIME-Version: 1.0`,
    "",
    body,
  ].filter((line): line is string => line !== undefined);
  const raw = lines.join("\r\n");
  return Buffer.from(raw).toString("base64url");
}

/** Pulls the bare address out of a "Display Name <addr@x.com>" header value. */
function extractAddress(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/);
  return (match ? match[1]! : headerValue).trim();
}

/**
 * Transform a raw Corsair thread (with metadata headers) into a ThreadSummary.
 */
function extractThreadSummary(thread: Record<string, unknown>): ThreadSummary {

  const messages = (thread.messages ?? []) as Array<Record<string, unknown>>;
  // Use the first message for subject, last message for sender/date
  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1] ?? firstMsg;

  const firstHeaders = ((firstMsg?.payload as MessagePart)?.headers ?? []) as PayloadHeader[];
  const lastHeaders = ((lastMsg?.payload as MessagePart)?.headers ?? []) as PayloadHeader[];

  return {
    threadId: (thread.id as string) ?? "",
    sender: getHeader(lastHeaders, "From"),
    subject: getHeader(firstHeaders, "Subject") || "(no subject)",
    date: getHeader(lastHeaders, "Date"),
    snippet: (firstMsg?.snippet as string) ?? (messages[0]?.snippet as string) ?? "",
  };
}

/**
 * Transform a raw Corsair thread (full format) into a ThreadDetail.
 */
function transformThreadDetail(thread: Record<string, unknown>): ThreadDetail {
  const messages = (thread.messages ?? []) as Array<Record<string, unknown>>;

  const firstMsg = messages[0];
  const firstHeaders = ((firstMsg?.payload as MessagePart)?.headers ?? []) as PayloadHeader[];

  const detailedMessages: MessageDetail[] = messages.map((msg) => {
    const payload = msg.payload as MessagePart | undefined;
    const headers = (payload?.headers ?? []) as PayloadHeader[];

    return {
      id: (msg.id as string) ?? "",
      from: getHeader(headers, "From"),
      to: getHeader(headers, "To"),
      subject: getHeader(headers, "Subject") || "(no subject)",
      date: getHeader(headers, "Date"),
      body: extractBody(payload),
      htmlBody: extractHtml(payload),
      snippet: (msg.snippet as string) ?? "",
    };
  });

  return {
    threadId: (thread.id as string) ?? "",
    subject: getHeader(firstHeaders, "Subject") || "(no subject)",
    messages: detailedMessages,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * List inbox threads with sender/subject/date.
 * Uses threads.list → threads.get (metadata) pattern to get headers
 * without downloading full message bodies.
 */
export async function getThreads(
  tenantId: string,
  opts?: { maxResults?: number; pageToken?: string }
): Promise<ThreadListResult> {
  const startMs = Date.now();
  const tenant = corsair.withTenant(tenantId);

  // Step 1: Get thread IDs
  const gmailStart = Date.now();
  const result = await tenant.gmail.api.threads.list({
    maxResults: opts?.maxResults ?? 20,
    pageToken: opts?.pageToken,
    labelIds: ["INBOX"],
  });
  logger.info("[GMAIL] threads.list (getThreads)", {
    tenantId, threadCount: (result.threads ?? []).length,
    hasNextPage: !!result.nextPageToken, durationMs: Date.now() - gmailStart,
  });

  const threadStubs = result.threads ?? [];
  if (threadStubs.length === 0) {
    return { threads: [], nextPageToken: null };
  }

  // Step 2: Fetch metadata for each thread in parallel
  const threadGetStart = Date.now();
  const detailed = await Promise.all(
    threadStubs.map((t: { id?: string }) =>
      tenant.gmail.api.threads.get({
        id: t.id!,
        format: "metadata",
      })
    )
  );
  logger.info("[GMAIL] threads.get batch (getThreads)", {
    tenantId, threadCount: detailed.length, durationMs: Date.now() - threadGetStart,
  });

  // Step 3: Transform to ThreadSummary[]
  const threads = detailed.map((t: Record<string, unknown>) =>{
      return extractThreadSummary(t as Record<string, unknown>)
    }
  );

  logger.info("[SERVICE] getThreads completed", {
    tenantId, threadCount: threads.length,
    nextPageToken: result.nextPageToken ?? null,
    totalDurationMs: Date.now() - startMs,
  });

  return {
    threads,
    nextPageToken: result.nextPageToken ?? null,
  };
}

/**
 * Get a single thread with all messages (full format).
 */
export async function getThread(
  tenantId: string,
  threadId: string
): Promise<ThreadDetail> {
  const startMs = Date.now();
  const tenant = corsair.withTenant(tenantId);

  const gmailStart = Date.now();
  const thread = await tenant.gmail.api.threads.get({
    id: threadId,
    format: "full",
  });
  logger.info("[GMAIL] threads.get (getThread)", {
    tenantId, threadId, durationMs: Date.now() - gmailStart,
  });

  const result = transformThreadDetail(thread as unknown as Record<string, unknown>);

  // Query metadata for priority status and reason
  const meta = await db
    .select({
      priority: messageMetadata.priority,
      priorityScore: messageMetadata.priorityScore,
      priorityReason: messageMetadata.priorityReason,
      isActionRequired: messageMetadata.isActionRequired,
      // Carried so an already-paid-for summary renders with the thread
      // instead of needing a round trip that looks like a second charge.
      summary: messageMetadata.summary,
      summaryDigest: messageMetadata.summaryDigest,
      summaryFullText: messageMetadata.summaryFullText,
      summaryFlags: messageMetadata.summaryFlags,
    })
    .from(messageMetadata)
    .where(and(eq(messageMetadata.threadId, threadId), eq(messageMetadata.userId, tenantId)))
    .limit(1);

  if (meta[0]) {
    result.priority = meta[0].priority ?? undefined;
    result.priorityScore = meta[0].priorityScore ?? undefined;
    result.priorityReason = meta[0].priorityReason ?? undefined;
    result.isActionRequired = meta[0].isActionRequired ?? undefined;
    result.summary = meta[0].summary ?? undefined;
    result.summaryDigest = meta[0].summaryDigest ?? undefined;
    result.summaryFullText = meta[0].summaryFullText ?? undefined;
    result.summaryFlags = meta[0].summaryFlags ?? undefined;
  }

  logger.info("[SERVICE] getThread completed", {
    tenantId, threadId, messageCount: result.messages?.length ?? 0,
    totalDurationMs: Date.now() - startMs,
  });
  return result;
}

/**
 * Send an email. Constructs RFC 2822 from to/subject/body,
 * base64url-encodes it, and calls messages.send().
 */
export async function sendEmail(
  tenantId: string,
  input: SendEmailInput
): Promise<SendEmailResult> {
  const startMs = Date.now();
  logger.info("[SERVICE] sendEmail start", {
    tenantId, to: input.to, subject: input.subject, hasThreadId: !!input.threadId,
  });
  const tenant = corsair.withTenant(tenantId);

  const raw = buildRawEmail(input.to, input.subject, input.body);

  const result = await tenant.gmail.api.messages.send({
    raw,
    threadId: input.threadId,
  });

  logger.info("[SERVICE] sendEmail completed", {
    tenantId, messageId: result.id, threadId: result.threadId,
    durationMs: Date.now() - startMs,
  });

  return {
    id: result.id ?? "",
    threadId: result.threadId ?? "",
  };
}

interface ResolvedReplyTarget {
  recipient: string;
  ccAddresses?: string;
  subject: string;
  messageId: string;
  references: string;
  threadId: string;
}

/**
 * Resolves WHO and WHAT SUBJECT a reply targets, from the original message
 * fetched fresh from Gmail — never from the model. Shared by the real send
 * (replyToEmail) and the approval-preview builder (previewReply) so the
 * preview the user approves and the message actually sent are derived from
 * the exact same resolution, not two hand-kept-in-sync copies.
 */
async function resolveReplyTarget(
  tenantId: string,
  entityId: string,
  replyAll?: boolean,
): Promise<ResolvedReplyTarget> {
  const tenant = corsair.withTenant(tenantId);
  const original = (await tenant.gmail.api.messages.get({
    id: entityId,
    format: "full",
  })) as Record<string, unknown>;

  const headers = ((original.payload as MessagePart)?.headers ?? []) as PayloadHeader[];
  const from = getHeader(headers, "From");
  const replyTo = getHeader(headers, "Reply-To") || from;
  const to = getHeader(headers, "To");
  const cc = getHeader(headers, "Cc");
  const subject = getHeader(headers, "Subject");
  const messageId = getHeader(headers, "Message-ID");
  const existingReferences = getHeader(headers, "References");

  const recipient = extractAddress(replyTo);
  if (!recipient) {
    throw new Error("Could not determine a reply recipient from the original message");
  }

  let ccAddresses: string | undefined;
  if (replyAll) {
    const others = new Set<string>();
    for (const raw of `${to},${cc}`.split(",")) {
      const addr = extractAddress(raw.trim());
      if (addr && addr.toLowerCase() !== recipient.toLowerCase()) others.add(addr);
    }
    if (others.size > 0) ccAddresses = Array.from(others).join(", ");
  }

  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const references = [existingReferences, messageId].filter(Boolean).join(" ").trim();

  return {
    recipient,
    ccAddresses,
    subject: replySubject,
    messageId,
    references,
    threadId: (original.threadId as string) ?? "",
  };
}

/**
 * Reply to a specific message. Recipient, subject, and threading headers
 * (In-Reply-To/References, built from the original's own Message-ID) are
 * ALL derived from the original message — never from the model. This
 * matters beyond correctness: the assistant only ever sees the sender as
 * the literal string "[EMAIL]" (PII masking replaces every address before
 * content reaches it — see packages/ai/src/security/pii.ts), so it could
 * not supply a correct recipient even if asked to.
 */
export async function replyToEmail(
  tenantId: string,
  input: ReplyToEmailInput,
): Promise<SendEmailResult> {
  const startMs = Date.now();
  logger.info("[SERVICE] replyToEmail start", { tenantId, entityId: input.entityId, replyAll: input.replyAll });

  const target = await resolveReplyTarget(tenantId, input.entityId, input.replyAll);

  const raw = buildRawEmail(target.recipient, target.subject, input.body, {
    cc: target.ccAddresses,
    inReplyTo: target.messageId || undefined,
    references: target.references || undefined,
  });

  const tenant = corsair.withTenant(tenantId);
  const result = await tenant.gmail.api.messages.send({
    raw,
    threadId: target.threadId || undefined,
  });

  logger.info("[SERVICE] replyToEmail completed", {
    tenantId, messageId: result.id, threadId: result.threadId, durationMs: Date.now() - startMs,
  });

  return { id: result.id ?? "", threadId: result.threadId ?? "" };
}

/**
 * Read-only preview of what replyToEmail would send — for the approval card
 * shown before the user consents. No send, no side effects.
 */
export async function previewReply(
  tenantId: string,
  entityId: string,
  replyAll?: boolean,
): Promise<{ to: string; cc?: string; subject: string }> {
  const target = await resolveReplyTarget(tenantId, entityId, replyAll);
  return { to: target.recipient, cc: target.ccAddresses, subject: target.subject };
}

interface ResolvedForwardTarget {
  subject: string;
  quoted: string;
  attachmentCount: number;
}

async function resolveForwardTarget(tenantId: string, entityId: string): Promise<ResolvedForwardTarget> {
  const tenant = corsair.withTenant(tenantId);
  const original = (await tenant.gmail.api.messages.get({
    id: entityId,
    format: "full",
  })) as Record<string, unknown>;

  const payload = original.payload as MessagePart | undefined;
  const headers = (payload?.headers ?? []) as PayloadHeader[];
  const from = getHeader(headers, "From");
  const to = getHeader(headers, "To");
  const date = getHeader(headers, "Date");
  const subject = getHeader(headers, "Subject");
  const bodyText = extractBody(payload) || (original.snippet as string) || "";
  const attachmentCount = countAttachments(payload);

  const forwardSubject = /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
  const quoted = [
    "---------- Forwarded message ---------",
    `From: ${from}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    `To: ${to}`,
    "",
    bodyText,
  ].join("\n");

  return { subject: forwardSubject, quoted, attachmentCount };
}

/**
 * Forward a specific message. The model supplies only the recipient and an
 * optional covering note — the quoted original is assembled here from the
 * message fetched fresh from Gmail, never authored by the model. This
 * avoids the trap of forwarding a paraphrase: after fullText was dropped
 * from summarizeEmail's tool output, the model only ever holds a digest, so
 * a model-authored "forward" would silently send a summary instead of the
 * actual email.
 */
export async function forwardEmail(
  tenantId: string,
  input: ForwardEmailInput,
): Promise<SendEmailResult> {
  const startMs = Date.now();
  logger.info("[SERVICE] forwardEmail start", { tenantId, entityId: input.entityId, to: input.to });

  const target = await resolveForwardTarget(tenantId, input.entityId);
  // buildRawEmail is text/plain only — attachments are never carried over.
  // Say so in the sent message itself, not just the approval preview, since
  // the forward's recipient has no other way to know something was dropped.
  const attachmentNote =
    target.attachmentCount > 0
      ? `\n\n[${target.attachmentCount} attachment${target.attachmentCount === 1 ? "" : "s"} on the original message could not be forwarded.]`
      : "";
  const composedBody = (input.note ? `${input.note}\n\n${target.quoted}` : target.quoted) + attachmentNote;
  const raw = buildRawEmail(input.to, target.subject, composedBody);

  const tenant = corsair.withTenant(tenantId);
  const result = await tenant.gmail.api.messages.send({ raw });

  logger.info("[SERVICE] forwardEmail completed", {
    tenantId, messageId: result.id, threadId: result.threadId, durationMs: Date.now() - startMs,
  });

  return { id: result.id ?? "", threadId: result.threadId ?? "" };
}

/**
 * Read-only preview of what forwardEmail would send — for the approval
 * card. No send, no side effects.
 */
export async function previewForward(
  tenantId: string,
  entityId: string,
): Promise<{ subject: string; attachmentCount: number }> {
  const target = await resolveForwardTarget(tenantId, entityId);
  return { subject: target.subject, attachmentCount: target.attachmentCount };
}

/**
 * Search emails by query string (uses Gmail search syntax).
 * Returns ThreadSummary[] matching the query.
 */
export async function searchEmails(
  tenantId: string,
  query: string,
  opts?: { maxResults?: number; pageToken?: string }
): Promise<ThreadListResult> {
  const startMs = Date.now();
  logger.info("[SERVICE] searchEmails start", {
    tenantId, query, maxResults: opts?.maxResults, pageToken: opts?.pageToken,
  });

  const tenant = corsair.withTenant(tenantId);

  const gmailStart = Date.now();
  const result = await tenant.gmail.api.threads.list({
    q: query,
    maxResults: opts?.maxResults ?? 20,
    pageToken: opts?.pageToken,
  });
  logger.info("[GMAIL] threads.list (searchEmails)", {
    tenantId, query,
    threadCount: (result.threads ?? []).length,
    nextPageToken: result.nextPageToken ?? null,
    gmailDurationMs: Date.now() - gmailStart,
  });

  const threadStubs = result.threads ?? [];
  if (threadStubs.length === 0) {
    return { threads: [], nextPageToken: null };
  }

  const detailed = await Promise.all(
    threadStubs.map((t: { id?: string }) =>
      tenant.gmail.api.threads.get({
        id: t.id!,
        format: "metadata",
      })
    )
  );
  logger.info("[GMAIL] threads.get batch (searchEmails)", {
    tenantId, query, threadCount: detailed.length,
    durationMs: Date.now() - gmailStart,
  });

  const threads = detailed.map((t: Record<string, unknown>) =>
    extractThreadSummary(t as Record<string, unknown>)
  );

  logger.info("[SERVICE] searchEmails completed", {
    tenantId, query, threadCount: threads.length,
    nextPageToken: result.nextPageToken ?? null,
    totalDurationMs: Date.now() - startMs,
  });

  return {
    threads,
    nextPageToken: result.nextPageToken ?? null,
  };
}

/**
 * Ingest a single Gmail message: fetches full details, inserts/upserts into emails,
 * derives category and flags, updates message_metadata, and optionally triggers embeddings.
 */
/**
 * Which code path caused a message to be ingested.
 *
 * ingestMessage cannot know its own caller, and without that the only emitter
 * of `email.received` is anonymous — a backlog of classification runs gives no
 * hint which path produced it. Answering "who triggered these?" for a 70k-deep
 * queue meant reading three files; this makes it a dashboard filter.
 */
export type IngestSource =
  | "webhook"
  | "sync-emails"
  | "initial-sync"
  | "manual-resync"
  | "unknown";

/**
 * True when Gmail says the message no longer exists (404 Not Found / 410 Gone).
 *
 * A history diff routinely names messages that were deleted between the
 * notification being emitted and us fetching them, so this is expected traffic
 * rather than a fault. It matters because it is the one failure that retrying
 * can never fix: the caller in webhook-sync.ts fails the whole diff if any
 * message throws, and the cursor only advances once the diff succeeds — so a
 * permanently-deleted message would wedge the cursor forever and starve every
 * newer email behind it.
 *
 * Matched loosely on purpose. Corsair defines no error handling of its own and
 * its default handler logs only `e.message` (see apps/api/src/diagnostics/
 * describe-error.ts), so a status code is not guaranteed to survive — the
 * observed shape in production was the bare string "Not Found".
 */
function isMessageGone(err: unknown): boolean {
  const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (err as { statusCode?: unknown } | null)?.statusCode;
  if (status === 404 || status === 410) return true;

  const message = (err as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message : String(err ?? "");
  return /\b(404|410)\b|not found|notfound|gone/i.test(text);
}

export async function ingestMessage(
  tenantId: string,
  messageId: string,
  triggerEmbeddings = true,
  // Per-email classification is right for the webhook (one new email, classify
  // it now) and wrong for any bulk caller: syncEmails walks the whole mailbox,
  // so leaving this on emits one event — and one LLM call — per unread email.
  // A fresh account with 2,671 unread emails queued 2,671 runs. Bulk callers
  // pass false and let the batch classifier pick the rows up from PENDING,
  // which is what it exists for.
  triggerClassification = true,
  // Provenance, carried into the email.received event and both log lines.
  // Callers name themselves; "unknown" means someone added a call site without
  // doing so.
  source: IngestSource = "unknown",
  // Groups every event emitted by one logical trigger — the Gmail delivery's
  // historyId on the webhook path, one id per invocation for bulk paths. A
  // fan-out can then be traced back to the single trigger that caused it,
  // which is what distinguishes "N new emails" from "one diff retried N times".
  correlationId?: string
): Promise<void> {
  const startMs = Date.now();
  logger.info("[SERVICE] ingestMessage start", { tenantId, messageId, source, correlationId });

  const tenant = corsair.withTenant(tenantId);

  // Fetch full message details. Guarded on both paths — whether Corsair throws
  // on a missing message or swallows it and hands back nothing is not something
  // its types promise, and the difference between the two is a skipped message
  // versus a TypeError on `raw.payload` below.
  let msg: unknown;
  try {
    msg = await tenant.gmail.api.messages.get({
      id: messageId,
      format: "full",
    });
  } catch (err) {
    if (isMessageGone(err)) {
      logger.info("[SERVICE] ingestMessage skipped: message no longer exists", {
        tenantId,
        messageId,
        source,
        correlationId,
      });
      return;
    }
    // Anything else is a real failure (auth, transport, quota) and must keep
    // propagating so the caller refuses to advance its cursor past it.
    throw err;
  }

  if (msg === null || typeof msg !== "object") {
    logger.info("[SERVICE] ingestMessage skipped: no message returned", {
      tenantId,
      messageId,
      source,
      correlationId,
    });
    return;
  }

  const raw = msg as Record<string, unknown>;
  const payload = raw.payload as MessagePart | undefined;
  const headers = (payload?.headers ?? []) as PayloadHeader[];

  const dateHeader = getHeader(headers, "Date");
  const receivedAt = dateHeader
    ? new Date(dateHeader)
    : new Date(Number(raw.internalDate));

  const threadId = (raw.threadId as string) ?? "";
  const subject = getHeader(headers, "Subject") || null;
  const from = getHeader(headers, "From") || null;
  const to = getHeader(headers, "To") || null;
  const snippet = (raw.snippet as string) ?? null;
  const bodyText = extractBody(payload) || null;
  const labels: string[] = (raw.labelIds as string[]) ?? [];

  // Classify and derive metadata
  const category = deriveCategory(labels);
  const flags = deriveFlags(labels);

  const emailRow = {
    userId: tenantId,
    gmailMessageId: messageId,
    threadId,
    subject,
    from,
    to,
    snippet,
    bodyText,
    rawPayload: raw,
    receivedAt: isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    lastSyncedAt: new Date(),
  };

  // 1. Store in emails table
  await db
    .insert(emails)
    .values(emailRow)
    .onConflictDoUpdate({
      target: emails.gmailMessageId,
      set: {
        threadId: emailRow.threadId,
        subject: emailRow.subject,
        from: emailRow.from,
        to: emailRow.to,
        snippet: emailRow.snippet,
        bodyText: emailRow.bodyText,
        rawPayload: emailRow.rawPayload,
        receivedAt: emailRow.receivedAt,
        lastSyncedAt: emailRow.lastSyncedAt,
        updatedAt: new Date(),
      },
    });

  // 2. Store in message_metadata table
  await upsertMessageMetadata({
    entityId: messageId,
    userId: tenantId,
    gmailLabels: labels,
    sender: from || undefined,
    subject: subject || undefined,
    snippet: snippet || undefined,
    category,
    ...flags,
    receivedAt: emailRow.receivedAt,
    threadId,
  });

  // Trigger priority classification for unread emails (commit success before emitting event)
  if (flags.isUnread && triggerClassification) {
    const { inngest } = await import("@repo/inngest");
    void inngest
      .send({
        name: "email.received",
        // Identifiers and provenance only — deliberately no mail content.
        // The consumer reads sender/subject/snippet from message_metadata
        // itself, so duplicating them here would only inflate the event
        // (Inngest caps payload size) without saving the consumer a query.
        data: { userId: tenantId, entityId: messageId, source, correlationId },
      })
      .catch((err) => {
        logger.error("[SERVICE] failed to send email.received event in ingestMessage", {
          tenantId,
          messageId,
          source,
          correlationId,
          error: String(err),
        });
      });
  }

  // 3. Trigger embeddings asynchronously (fire-and-forget)
  if (triggerEmbeddings) {
    void generateMissingEmbeddings(tenantId).catch((err) => {
      logger.error("[SERVICE] generateMissingEmbeddings failed in ingestMessage", { tenantId, messageId, error: String(err) });
    });
  }

  logger.info("[SERVICE] ingestMessage completed", {
    tenantId,
    messageId,
    source,
    correlationId,
    durationMs: Date.now() - startMs,
  });
}


/**
 * Sync the first 100 Gmail messages into local Postgres.
 * Batches 10 at a time. Idempotent — re-running updates existing rows.
 */
export async function syncEmails(tenantId: string, userId: string): Promise<SyncResult> {
  const startMs = Date.now();
  // One id for the whole invocation, so every message this sync touches is
  // attributable to this specific run of it.
  const correlationId = randomUUID();
  logger.info("[SERVICE] syncEmails start", { tenantId, userId, correlationId });

  const tenant = corsair.withTenant(tenantId);

  // Step 1: list message IDs
  const gmailStart = Date.now();
  const result = await tenant.gmail.api.messages.list({ maxResults: 100 });
  const stubs = (result.messages ?? []) as Array<{ id?: string; threadId?: string }>;
  const valid = stubs.filter((s) => s.id);
  logger.info("[GMAIL] messages.list (syncEmails)", {
    tenantId, foundCount: valid.length, gmailDurationMs: Date.now() - gmailStart,
  });
  if (valid.length === 0) return { synced: 0 };

  // Step 2: Ingest all messages in batches of 10
  const BATCH_SIZE = 10;
  let synced = 0;

  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const batch = valid.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map((stub) =>
        // No per-email classification: this walks the whole mailbox. Rows land
        // as PENDING and the batch classifier handles them.
        ingestMessage(tenantId, stub.id!, false, false, "sync-emails", correlationId).catch((err) =>
          logger.error("[DB] syncEmails upsert failed", {
            gmailMessageId: stub.id,
            correlationId,
            error: String(err),
          })
        )
      )
    );

    synced += batch.length;
    logger.debug("[SERVICE] syncEmails batch processed", { batchIndex: i / BATCH_SIZE + 1, batchSize: batch.length });
  }

  // Step 3: Trigger embeddings for all newly synced emails at once (fire-and-forget)
  void generateMissingEmbeddings(tenantId).catch((err) => {
    logger.error("[SERVICE] generateMissingEmbeddings failed in syncEmails", { tenantId, error: String(err) });
  });

  logger.info("[SERVICE] syncEmails completed", { tenantId, synced, totalDurationMs: Date.now() - startMs });
  return { synced };
}

/**
 * Returns the count of locally stored emails for a given user (for verification UI).
 */
export async function getStoredEmailCount(userId: string): Promise<EmailCount> {
  const startMs = Date.now();
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(emails)
    .where(eq(emails.userId, userId));
  const count = Number(result[0]?.count ?? 0);
  logger.debug("[DB] getStoredEmailCount", { userId, count, durationMs: Date.now() - startMs });
  return { count };
}

/**
 * Search ALL locally indexed emails for the given user.
 *
 * Primary path: pgvector cosine similarity search via `<=>` operator.
 *   - Embeds the query using @repo/ai
 *   - Orders by cosine distance ASC (lower = more similar)
 *   - Returns top 20 results
 *
 * Fallback path: ILIKE text search.
 *   - Only used if vector search fails (API down, no credits, etc.)
 *   - Searches bodyText, subject, from, snippet
 *
 * Sender-filtered path (`sender` given): delegates to searchBySender, which
 * always filters to rows whose `from` column matches `sender` — a real
 * `WHERE ... ILIKE` filter, not a fold-into-the-embedding-text guess. This
 * exists because plain vector search over "mails from X@gmail.com" ranks by
 * semantic closeness to that phrase, not by actual sender, and can surface
 * unrelated emails (e.g. other Gmail-account-security notices) ahead of ones
 * genuinely from X. If `sender` is omitted but `query` literally contains an
 * email address, it's extracted and treated as `sender` automatically (a
 * safety net for when the caller didn't populate the structured field).
 *
 * Never crashes — always returns results or empty array.
 */
export async function searchLocalEmails(
  userId: string,
  args: {
    query?: string;
    sender?: string;
    /** Only include mail received within this many days (unset = no bound). */
    withinDays?: number;
    /** When true, keep PROMOTIONS in the primary bucket (a "show promotions" drill-down). */
    includePromotions?: boolean;
    /**
     * Apply the assistant display rules: protected-sender/keyword blocklist,
     * primary/junk partition, and the small display cap. Only the assistant's
     * searchEmails tool sets this — the raw tRPC UI search keeps full,
     * unfiltered results (a user browsing their own inbox is not the AI).
     */
    applyAssistantRules?: boolean;
  },
): Promise<LocalSearchResult> {
  let { query, sender } = args;
  const { withinDays, includePromotions, applyAssistantRules } = args;

  if (!sender) {
    const extracted = extractEmail(query ?? "");
    if (extracted) {
      sender = extracted;
      query = (query ?? "").replace(extracted, "").trim();
    }
  }

  const topicGiven = !!query?.trim();
  // Broad inbox summary: no sender, no topic, but a date window given. Fetch
  // recent mail by recency (a semantic embed of an empty query is meaningless)
  // and give it a larger display budget than a normal fetch.
  const summaryMode = !sender && !topicGiven && withinDays != null;
  const primaryCap = summaryMode ? 40 : 10;

  let raw: ThreadSummary[];
  if (sender) {
    raw = (await searchBySender(userId, sender, query, withinDays)).threads;
  } else if (summaryMode) {
    raw = await searchByRecency(userId, withinDays ?? 30, 200);
  } else {
    const effectiveQuery = query ?? "";
    try {
      raw = dedupeThreads(await searchByEmbedding(userId, effectiveQuery, 20, withinDays));
      if (raw.length === 0) {
        logger.info(
          `[search] ⚠️ Vector search returned 0 results — falling back to ILIKE for "${effectiveQuery}"`,
          { userId, query: effectiveQuery },
        );
        raw = (await searchByText(userId, effectiveQuery, withinDays)).threads;
      }
    } catch (err) {
      logger.warn(
        `[search] ❌ Vector search failed — falling back to ILIKE for "${effectiveQuery}"`,
        { userId, query: effectiveQuery, err },
      );
      raw = (await searchByText(userId, effectiveQuery, withinDays)).threads;
    }
  }

  if (!applyAssistantRules) {
    // Raw UI search: full results, no blocklist/partition/cap.
    return { threads: raw, total: raw.length };
  }

  return finalizeSearch(userId, raw, { topicGiven, includePromotions: !!includePromotions, primaryCap });
}

/** Days-ago cutoff Date for a `withinDays` window, or null if unbounded. */
function windowCutoff(withinDays?: number): Date | null {
  if (withinDays == null || !Number.isFinite(withinDays) || withinDays <= 0) return null;
  return new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);
}

/**
 * Post-process raw search rows before they reach the assistant:
 *   1. Drop protected-sender / protected-keyword mail entirely (blocklist).
 *   2. Enrich each row with its Gmail category from message_metadata.
 *   3. Partition into primary vs junk (PROMOTIONS/SPAM/TRASH), cap the primary
 *      bucket, and surface the hidden counts for disclosure.
 */
async function finalizeSearch(
  userId: string,
  raw: ThreadSummary[],
  opts: { topicGiven: boolean; includePromotions: boolean; primaryCap: number },
): Promise<LocalSearchResult> {
  const blocklist = await getProtectedConfig(userId);

  const hiddenSenders = new Set<string>();
  const afterProtected: ThreadSummary[] = [];
  for (const t of raw) {
    const matchedSender = matchProtectedSender(t.sender, blocklist.senders);
    const matchedKeyword = matchProtectedKeyword(`${t.subject}\n${t.snippet}`, blocklist.keywords);
    if (matchedSender || matchedKeyword) {
      if (matchedSender) hiddenSenders.add(matchedSender);
      continue;
    }
    afterProtected.push(t);
  }
  const hiddenProtectedCount = raw.length - afterProtected.length;

  const enriched = await enrichCategories(userId, afterProtected);
  const { primary, primaryTotal, spamCount } = partitionSearchResults(enriched, opts);

  return {
    threads: primary,
    total: primaryTotal,
    spamCount,
    hiddenProtected:
      hiddenProtectedCount > 0
        ? { count: hiddenProtectedCount, senders: [...hiddenSenders] }
        : undefined,
  };
}

/** Batch-load each row's Gmail category from message_metadata (keyed by entityId). */
async function enrichCategories(
  userId: string,
  threads: ThreadSummary[],
): Promise<ThreadSummary[]> {
  const ids = threads.map((t) => t.entityId).filter((id): id is string => !!id);
  if (ids.length === 0) return threads;

  const rows = await db
    .select({ entityId: messageMetadata.entityId, category: messageMetadata.category })
    .from(messageMetadata)
    .where(and(eq(messageMetadata.userId, userId), inArray(messageMetadata.entityId, ids)));

  const catById = new Map(rows.map((r) => [r.entityId, r.category]));
  return threads.map((t) => ({
    ...t,
    category: (t.entityId ? catById.get(t.entityId) : undefined) ?? t.category ?? undefined,
  }));
}

/** Recent mail within the window, newest first — the "summarize my inbox" source. */
async function searchByRecency(
  userId: string,
  withinDays: number,
  limit: number,
): Promise<ThreadSummary[]> {
  const cutoff = windowCutoff(withinDays);
  const rows = await db
    .select({
      gmailMessageId: emails.gmailMessageId,
      threadId: emails.threadId,
      subject: emails.subject,
      from: emails.from,
      snippet: emails.snippet,
      receivedAt: emails.receivedAt,
    })
    .from(emails)
    .where(
      cutoff
        ? and(eq(emails.userId, userId), gte(emails.receivedAt, cutoff))
        : eq(emails.userId, userId),
    )
    .orderBy(sql`${emails.receivedAt} DESC NULLS LAST`)
    .limit(limit);

  return dedupeThreads(
    rows.map((r) => ({
      threadId: r.threadId,
      entityId: r.gmailMessageId,
      sender: r.from ?? "",
      subject: r.subject ?? "(no subject)",
      date: r.receivedAt ? new Date(r.receivedAt).toISOString() : "",
      snippet: r.snippet ?? "",
    })),
  );
}

/**
 * Pulls a literal email address (`word@domain.tld`) out of free text.
 * Deliberately dumb: only matches the exact shape of an address, never a
 * display name or company — see BUGS.md for why guessing at names is unsafe.
 */
function extractEmail(text: string): string | undefined {
  const match = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return match?.[0];
}

/**
 * Collapses rows with an identical (sender, subject, snippet) triple,
 * keeping the first (best-ranked or newest, depending on caller's ORDER BY).
 * Fixes the duplicate-row symptom from BUGS.md, where near-identical emails
 * (e.g. repeated security alerts) all ranked back-to-back with no dedup.
 */
function dedupeThreads(threads: ThreadSummary[]): ThreadSummary[] {
  const seen = new Set<string>();
  const out: ThreadSummary[] = [];
  for (const t of threads) {
    const key = `${t.sender}|${t.subject}|${t.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Sender-filtered search (Bug 2 fix). Always applies a real `WHERE from
 * ILIKE %sender%` filter — `from` is stored as free text ("Name <email>"),
 * so this matches whether the user gave a display name or the bare address.
 *
 * Hybrid ranking: if topic text remains after the sender was identified,
 * ranks the sender-filtered rows by vector similarity to that topic (e.g.
 * "from X regarding invoices"). Otherwise returns them newest-first, which
 * is what "fetch the last N emails from X" means.
 */
async function searchBySender(
  userId: string,
  sender: string,
  query?: string,
  withinDays?: number,
): Promise<LocalSearchResult> {
  const meaningfulQuery = query?.trim();
  const pattern = `%${sender}%`;
  const cutoff = windowCutoff(withinDays);
  const dateClause = cutoff ? sql`AND ${emails.receivedAt} >= ${cutoff}` : sql``;

  if (meaningfulQuery) {
    try {
      const startMs = Date.now();
      const queryVector = await embedSearchQuery(meaningfulQuery);
      const vectorLiteral = `[${queryVector.join(",")}]`;

      const result = await db.execute<{
        gmail_message_id: string;
        thread_id: string;
        subject: string | null;
        from: string | null;
        snippet: string | null;
        received_at: Date | null;
        distance: number;
      }>(
        sql`
          SELECT ${emails.gmailMessageId}, ${emails.threadId}, ${emails.subject}, ${emails.from}, ${emails.snippet}, ${emails.receivedAt},
            ${emails.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector`)} AS distance
          FROM ${emails}
          WHERE ${eq(emails.userId, userId)} AND ${ilike(emails.from, pattern)} AND ${emails.embedding} IS NOT NULL ${dateClause}
          ORDER BY distance ASC
          LIMIT 20
        `,
      );

      const threads = dedupeThreads(
        result.rows.map((r) => ({
          threadId: r.thread_id,
          entityId: r.gmail_message_id,
          sender: r.from ?? "",
          subject: r.subject ?? "(no subject)",
          date: r.received_at ? new Date(r.received_at).toISOString() : "",
          snippet: r.snippet ?? "",
          score: Math.max(0, Math.min(1, 1 - Number(r.distance))),
        })),
      );

      logger.info(
        `[search] ✅ Sender+topic search — ${threads.length} results for sender "${sender}", topic "${meaningfulQuery}"`,
        { userId, sender, query: meaningfulQuery, count: threads.length, durationMs: Date.now() - startMs },
      );
      if (threads.length > 0) return { threads, total: threads.length };
      // No topic-ranked matches for this sender — fall through to a plain
      // recency listing of everything from them, rather than returning empty.
    } catch (err) {
      logger.warn(
        `[search] ❌ Sender+topic vector search failed — falling back to recency for sender "${sender}"`,
        { userId, sender, query: meaningfulQuery, err },
      );
      // fall through to recency listing below
    }
  }

  const rows = await db
    .select({
      gmailMessageId: emails.gmailMessageId,
      threadId: emails.threadId,
      subject: emails.subject,
      from: emails.from,
      snippet: emails.snippet,
      receivedAt: emails.receivedAt,
    })
    .from(emails)
    .where(
      cutoff
        ? and(eq(emails.userId, userId), ilike(emails.from, pattern), gte(emails.receivedAt, cutoff))
        : and(eq(emails.userId, userId), ilike(emails.from, pattern)),
    )
    .orderBy(sql`${emails.receivedAt} DESC NULLS LAST`);

  const threads: ThreadSummary[] = dedupeThreads(
    rows.map((r) => ({
      threadId: r.threadId,
      entityId: r.gmailMessageId,
      sender: r.from ?? "",
      subject: r.subject ?? "(no subject)",
      date: r.receivedAt ? new Date(r.receivedAt).toISOString() : "",
      snippet: r.snippet ?? "",
    })),
  );

  logger.info(
    `[search] ✅ Sender search (recency) — ${threads.length} results for sender "${sender}"`,
    { userId, sender, count: threads.length },
  );
  return { threads, total: threads.length };
}

/**
 * pgvector cosine similarity search.
 * Uses `<=>` operator (cosine distance, lower = more similar, ASC = best first).
 * Only searches emails that have embeddings.
 */
async function searchByEmbedding(
  userId: string,
  query: string,
  limit: number,
  withinDays?: number,
): Promise<ThreadSummary[]> {
  const startMs = Date.now();
  logger.debug("[SEARCH] searchByEmbedding (pgvector)", { userId, query, limit });

  const queryVector = await embedSearchQuery(query);
  const vectorLiteral = `[${queryVector.join(",")}]`;
  const cutoff = windowCutoff(withinDays);
  const dateClause = cutoff ? sql`AND ${emails.receivedAt} >= ${cutoff}` : sql``;

  const result = await db.execute<{
    gmail_message_id: string;
    thread_id: string;
    subject: string | null;
    from: string | null;
    snippet: string | null;
    received_at: Date | null;
    distance: number;
  }>(
    sql`
      SELECT ${emails.gmailMessageId}, ${emails.threadId}, ${emails.subject}, ${emails.from}, ${emails.snippet}, ${emails.receivedAt},
        ${emails.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector`)} AS distance
      FROM ${emails}
      WHERE ${eq(emails.userId, userId)} AND ${emails.embedding} IS NOT NULL ${dateClause}
      ORDER BY distance ASC
      LIMIT ${limit}
    `,
  );

  const threads = result.rows.map((r) => ({
    threadId: r.thread_id,
    entityId: r.gmail_message_id,
    sender: r.from ?? "",
    subject: r.subject ?? "(no subject)",
    date: r.received_at ? new Date(r.received_at).toISOString() : "",
    snippet: r.snippet ?? "",
    // Cosine distance -> similarity. Clamp: floating point can push this
    // fractionally past [0,1] at the extremes.
    score: Math.max(0, Math.min(1, 1 - Number(r.distance))),
  }));

  logger.debug("[SEARCH] searchByEmbedding result", { userId, query, resultCount: threads.length, durationMs: Date.now() - startMs });
  return threads;
}

/**
 * ILIKE text search fallback.
 * Same implementation as the original searchLocalEmails.
 */
async function searchByText(
  userId: string,
  query: string,
  withinDays?: number,
): Promise<LocalSearchResult> {
  const startMs = Date.now();
  logger.debug("[SEARCH] searchByText (ILIKE fallback)", { userId, query });

  const pattern = `%${query}%`;
  const cutoff = windowCutoff(withinDays);

  const rows = await db
    .select({
      gmailMessageId: emails.gmailMessageId,
      threadId: emails.threadId,
      subject: emails.subject,
      from: emails.from,
      snippet: emails.snippet,
      receivedAt: emails.receivedAt,
    })
    .from(emails)
    .where(
      and(
        eq(emails.userId, userId),
        or(
          ilike(emails.bodyText, pattern),
          ilike(emails.subject, pattern),
          ilike(emails.from, pattern),
          ilike(emails.snippet, pattern),
        ),
        ...(cutoff ? [gte(emails.receivedAt, cutoff)] : []),
      ),
    )
    .orderBy(sql`${emails.receivedAt} DESC NULLS LAST`);

  const threads: ThreadSummary[] = dedupeThreads(
    rows.map((r) => ({
      threadId: r.threadId,
      entityId: r.gmailMessageId,
      sender: r.from ?? "",
      subject: r.subject ?? "(no subject)",
      date: r.receivedAt ? new Date(r.receivedAt).toISOString() : "",
      snippet: r.snippet ?? "",
    })),
  );

  logger.info("[SEARCH] searchByText (ILIKE) result", { userId, query, resultCount: threads.length, durationMs: Date.now() - startMs });
  return { threads, total: threads.length };
}

// ── Embeddings ───────────────────────────────────────────────────────

const EMBED_BATCH_SIZE = 20;

/**
 * Validate the embeddings API connection on server boot.
 * Makes a lightweight test call to verify API key, model, network, and credits.
 * Logs result to console — no UI needed.
 */
export async function validateEmbeddingsApi(): Promise<void> {
  try {
    const embedding = await createEmbedding("test");

    if (!embedding || embedding.length === 0) {
      console.warn(`[embeddings] ⚠️ API responded but returned no vector`);
      return;
    }

    console.info(`[embeddings] ✅ API OK — dims=${embedding.length}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status;

    if (status === 401) {
      console.error(`[embeddings] ❌ Invalid API key (401). Check EMBEDDINGS_API_KEY.`);
    } else if (status === 402 || /insufficient|quota|credits?|billing/i.test(message)) {
      console.error(`[embeddings] ❌ Insufficient credits/quota (402). Check billing.`);
    } else if (status === 403) {
      console.error(`[embeddings] ❌ Access denied (403). Key lacks permissions.`);
    } else if (status === 404 || /not found|model/i.test(message)) {
      console.error(`[embeddings] ❌ Model not found. Check EMBEDDINGS_MODEL.`);
    } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
      console.error(`[embeddings] ❌ Cannot reach API. Network error.`);
    } else {
      console.error(`[embeddings] ❌ API failure — ${message}`);
    }
  }
}

interface EmbeddingRun {
  rerun: boolean;
  promise: Promise<EmbedResult>;
}

/**
 * In-flight embedding runs, keyed by userId. Two callers can otherwise overlap
 * — a webhook diff and a manual sync a second apart — and since the pending
 * SELECT below has no claim or lock between read and write, both would pick up
 * the same rows and pay the embedding API twice for them.
 *
 * Process-local. Good enough while the API runs as a single container; if this
 * is ever scaled horizontally, two processes will still overlap and this needs
 * to become a DB-backed lock (e.g. pg_advisory_lock on a hash of userId).
 */
const embeddingRuns = new Map<string, EmbeddingRun>();

/**
 * Generate embeddings for all emails that don't have one yet.
 * Batches 20 at a time using @repo/ai's createEmbeddingsBatch.
 * Idempotent — safe to re-run.
 *
 * Serialized per user: a call that arrives while another is running for the
 * same user does not start a second pass. It waits for the in-flight one and,
 * because that pass may have already run its pending-rows SELECT before the
 * caller's new emails landed, schedules exactly one follow-up pass to sweep
 * whatever the first missed. Without that follow-up, rows written during a run
 * would sit un-embedded until some unrelated sync happened to trigger another.
 */
export async function generateMissingEmbeddings(userId: string): Promise<EmbedResult> {
  const existing = embeddingRuns.get(userId);
  if (existing) {
    logger.info("[SERVICE] generateMissingEmbeddings already running, coalescing", { userId });
    existing.rerun = true;
    return existing.promise;
  }

  // The flag object is created before the async body so the body closes over
  // it directly, rather than re-reading the map and depending on `set` having
  // happened before the first await yields.
  const entry: EmbeddingRun = { rerun: false, promise: undefined! };

  entry.promise = (async (): Promise<EmbedResult> => {
    let total = 0;
    // Loops rather than recursing so a steady stream of concurrent callers
    // can't build an unbounded promise chain — `rerun` collapses any number
    // of overlapping requests into a single extra pass.
    for (;;) {
      const result = await runGenerateMissingEmbeddings(userId);
      total += result.embedded;
      if (!entry.rerun) break;
      entry.rerun = false;
    }
    return { embedded: total };
  })();

  embeddingRuns.set(userId, entry);
  try {
    return await entry.promise;
  } finally {
    embeddingRuns.delete(userId);
  }
}

async function runGenerateMissingEmbeddings(userId: string): Promise<EmbedResult> {
  const startMs = Date.now();
  logger.info("[SERVICE] generateMissingEmbeddings start", { userId });

  const unEmbedded = await db
    .select({
      id: emails.id,
      subject: emails.subject,
      bodyText: emails.bodyText,
    })
    .from(emails)
    .where(and(eq(emails.userId, userId), sql`${emails.embedding} IS NULL`));

  logger.info("[DB] generateMissingEmbeddings count pending", { userId, pendingCount: unEmbedded.length });

  if (unEmbedded.length === 0) {
    logger.info("[SERVICE] generateMissingEmbeddings - nothing to do", { userId });
    return { embedded: 0 };
  }

  let embedded = 0;

  for (let i = 0; i < unEmbedded.length; i += EMBED_BATCH_SIZE) {
    const batchStart = Date.now();
    const batch = unEmbedded.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(
      (e) => ((e.subject ?? "") + "\n\n" + (e.bodyText ?? "")).slice(0, 8000),
    );

    try {
      const vectors = await createEmbeddingsBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const vec = vectors[j];
        if (!vec) {
          logger.warn("[SERVICE] no vector returned for email, skipping", { emailId: batch[j]!.id });
          continue;
        }

        try {
          await db
            .update(emails)
            .set({ embedding: vec })
            .where(eq(emails.id, batch[j]!.id));
        } catch (dbErr) {
          logger.error("[DB] embedding DB update failed", { emailId: batch[j]!.id, error: String(dbErr) });
        }
      }

      embedded += batch.length;
      logger.debug("[SERVICE] generateMissingEmbeddings batch completed", {
        batchIndex: Math.floor(i / EMBED_BATCH_SIZE) + 1, batchSize: batch.length,
        batchDurationMs: Date.now() - batchStart,
      });
    } catch (apiErr) {
      logger.error("[SERVICE] embedding API batch failed", {
        batchIndex: Math.floor(i / EMBED_BATCH_SIZE) + 1, error: String(apiErr),
      });
    }
  }

  logger.info("[SERVICE] generateMissingEmbeddings completed", { userId, embedded, totalDurationMs: Date.now() - startMs });
  return { embedded };
}

/**
 * Count emails that still need embeddings generated.
 * Used for the "Generate Embeddings (N pending)" UI badge.
 */
export async function getPendingEmbeddingsCount(
  userId: string,
): Promise<PendingEmbeddingsCount> {
  const startMs = Date.now();
  const result = await db
    .select({ pending: sql<number>`count(*)` })
    .from(emails)
    .where(and(eq(emails.userId, userId), sql`${emails.embedding} IS NULL`));
  const pending = Number(result[0]?.pending ?? 0);
  logger.debug("[DB] getPendingEmbeddingsCount", { userId, pending, durationMs: Date.now() - startMs });
  return { pending };
}

export { getOrGenerateBrief, formatBriefingMarkdown } from "./daily-briefing.ts";

