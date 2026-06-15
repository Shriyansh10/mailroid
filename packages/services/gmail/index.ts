import { corsair } from "@repo/corsair";
import type {
  ThreadSummary,
  ThreadListResult,
  ThreadDetail,
  MessageDetail,
  SendEmailInput,
  SendEmailResult,
} from "./model.js";

// ── Helpers ──────────────────────────────────────────────────────────

interface PayloadHeader {
  name?: string;
  value?: string;
}

interface MessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  headers?: PayloadHeader[];
  parts?: MessagePart[];
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
 */
function buildRawEmail(to: string, subject: string, body: string): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `MIME-Version: 1.0`,
    "",
    body,
  ];
  const raw = lines.join("\r\n");
  return Buffer.from(raw).toString("base64url");
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
  const tenant = corsair.withTenant(tenantId);

  // Step 1: Get thread IDs
  const result = await tenant.gmail.api.threads.list({
    maxResults: opts?.maxResults ?? 20,
    pageToken: opts?.pageToken,
    labelIds: ["INBOX"],
  });

  const threadStubs = result.threads ?? [];
  if (threadStubs.length === 0) {
    return { threads: [], nextPageToken: null };
  }

  // Step 2: Fetch metadata for each thread in parallel
  const detailed = await Promise.all(
    threadStubs.map((t: { id?: string }) =>
      tenant.gmail.api.threads.get({
        id: t.id!,
        format: "metadata",
      })
    )
  );


  // Step 3: Transform to ThreadSummary[]
  const threads = detailed.map((t: Record<string, unknown>) =>{
      return extractThreadSummary(t as Record<string, unknown>)
    }
  );

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
  const tenant = corsair.withTenant(tenantId);

  const thread = await tenant.gmail.api.threads.get({
    id: threadId,
    format: "full",
  });

  return transformThreadDetail(thread as unknown as Record<string, unknown>);
}

/**
 * Send an email. Constructs RFC 2822 from to/subject/body,
 * base64url-encodes it, and calls messages.send().
 */
export async function sendEmail(
  tenantId: string,
  input: SendEmailInput
): Promise<SendEmailResult> {
  const tenant = corsair.withTenant(tenantId);

  const raw = buildRawEmail(input.to, input.subject, input.body);

  const result = await tenant.gmail.api.messages.send({
    raw,
    threadId: input.threadId,
  });

  return {
    id: result.id ?? "",
    threadId: result.threadId ?? "",
  };
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
  const tenant = corsair.withTenant(tenantId);

  const result = await tenant.gmail.api.threads.list({
    q: query,
    maxResults: opts?.maxResults ?? 20,
    pageToken: opts?.pageToken,
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

  const threads = detailed.map((t: Record<string, unknown>) =>
    extractThreadSummary(t as Record<string, unknown>)
  );

  return {
    threads,
    nextPageToken: result.nextPageToken ?? null,
  };
}
