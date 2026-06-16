import { corsair } from "@repo/corsair";
import { db, eq, sql, and, or, ilike } from "@repo/database";
import { emails } from "@repo/database/models/emails";
import type {
  ThreadSummary,
  ThreadListResult,
  ThreadDetail,
  MessageDetail,
  SendEmailInput,
  SendEmailResult,
  SyncResult,
  EmailCount,
  LocalSearchResult,
  EmbedResult,
  PendingEmbeddingsCount,
} from "./model.js";
import OpenAI from "openai";

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

// ── Email Storage ────────────────────────────────────────────────────

/**
 * Sync the first 100 Gmail messages into local Postgres.
 * Batches 10 at a time. Idempotent — re-running updates existing rows.
 */
export async function syncEmails(tenantId: string, userId: string): Promise<SyncResult> {
  const tenant = corsair.withTenant(tenantId);

  // Step 1: list message IDs
  const result = await tenant.gmail.api.messages.list({ maxResults: 100 });
  const stubs = (result.messages ?? []) as Array<{ id?: string; threadId?: string }>;
  const valid = stubs.filter((s) => s.id);
  console.log(`[syncEmails] tenant=${tenantId} found ${valid.length} messages to sync`);
  if (valid.length === 0) return { synced: 0 };

  // Step 2: fetch full messages in batches of 10
  const BATCH_SIZE = 10;
  let synced = 0;

  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const batch = valid.slice(i, i + BATCH_SIZE);

    const fetched = await Promise.all(
      batch.map((stub) =>
        tenant.gmail.api.messages.get({
          id: stub.id!,
          format: "full",
        })
      )
    );

    // Parse each message and upsert
    const rows = fetched.map((raw: unknown, idx: number) => {
      const msg = raw as Record<string, unknown>;
      const payload = msg.payload as MessagePart | undefined;
      const headers = (payload?.headers ?? []) as PayloadHeader[];

      const dateHeader = getHeader(headers, "Date");
      const receivedAt = dateHeader
        ? new Date(dateHeader)
        : new Date(Number(msg.internalDate));

      return {
        userId,
        gmailMessageId: (msg.id as string) ?? "",
        threadId: (msg.threadId as string) ?? batch[idx]!.threadId ?? "",
        subject: getHeader(headers, "Subject") || null,
        from: getHeader(headers, "From") || null,
        to: getHeader(headers, "To") || null,
        snippet: (msg.snippet as string) ?? null,
        bodyText: extractBody(payload) || null,
        rawPayload: msg as Record<string, unknown>,
        receivedAt: isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
        lastSyncedAt: new Date(),
      };
    });

    for (const row of rows) {
      try {
        await db
          .insert(emails)
          .values(row)
          .onConflictDoUpdate({
            target: emails.gmailMessageId,
            set: {
              threadId: row.threadId,
              subject: row.subject,
              from: row.from,
              to: row.to,
              snippet: row.snippet,
              bodyText: row.bodyText,
              rawPayload: row.rawPayload,
              receivedAt: row.receivedAt,
              lastSyncedAt: row.lastSyncedAt,
              updatedAt: new Date(),
            },
          });
      } catch (err) {
        console.error(`[syncEmails] failed to insert message ${row.gmailMessageId}:`, err);
      }
    }

    synced += rows.length;
  }

  console.log(`[syncEmails] done — synced ${synced} emails for tenant=${tenantId}`);
  return { synced };
}

/**
 * Returns the count of locally stored emails for a given user (for verification UI).
 */
export async function getStoredEmailCount(userId: string): Promise<EmailCount> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(emails)
    .where(eq(emails.userId, userId));
  return { count: Number(result[0]?.count ?? 0) };
}

/**
 * Search ALL locally indexed emails for the given user using ILIKE.
 * Scoped strictly to userId — never leaks across users.
 * Vector-search ready: swap ILIKE for embedding <=> queryEmbedding when available.
 */
export async function searchLocalEmails(
  userId: string,
  query: string,
): Promise<LocalSearchResult> {
  const pattern = `%${query}%`;

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
      ),
    )
    .orderBy(sql`${emails.receivedAt} DESC NULLS LAST`);

  const threads: ThreadSummary[] = rows.map((r) => ({
    threadId: r.threadId,
    sender: r.from ?? "",
    subject: r.subject ?? "(no subject)",
    date: r.receivedAt ? new Date(r.receivedAt).toISOString() : "",
    snippet: r.snippet ?? "",
  }));

  return { threads, total: threads.length };
}

// ── Embeddings ───────────────────────────────────────────────────────

function getEmbeddingsClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.EMBEDDINGS_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    baseURL: process.env.EMBEDDINGS_BASE_URL ?? process.env.OPENAI_BASE_URL ?? undefined,
  });
}

function getEmbeddingsModel(): string {
  return process.env.EMBEDDINGS_MODEL ?? "text-embedding-3-small";
}

const EMBED_BATCH_SIZE = 20;

/**
 * Validate the embeddings API connection on server boot.
 * Makes a lightweight test call to verify API key, model, network, and credits.
 * Logs result to console — no UI needed.
 */
export async function validateEmbeddingsApi(): Promise<void> {
  const client = getEmbeddingsClient();
  const model = getEmbeddingsModel();

  try {
    const response = await client.embeddings.create({ model, input: "test" });

    if (!response.data?.[0]?.embedding) {
      console.warn(`[embeddings] ⚠️ API responded but returned no vector (model: ${model})`);
      return;
    }

    console.info(`[embeddings] ✅ API OK — model=${model} base=${client.baseURL ?? "default"} dims=${response.data[0].embedding.length}`);
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
      console.error(`[embeddings] ❌ Model '${model}' not found at provider. Check EMBEDDINGS_MODEL.`);
    } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
      console.error(`[embeddings] ❌ Cannot reach ${client.baseURL ?? "API"}. Network error.`);
    } else {
      console.error(`[embeddings] ❌ API failure — ${message}`);
    }
  }
}

/**
 * Generate embeddings for all emails that don't have one yet.
 * Batches 20 at a time. Idempotent — safe to re-run.
 */
export async function generateMissingEmbeddings(userId: string): Promise<EmbedResult> {
  console.log(`[embeddings] starting for userId=${userId}`);

  const unEmbedded = await db
    .select({
      id: emails.id,
      subject: emails.subject,
      bodyText: emails.bodyText,
    })
    .from(emails)
    .where(and(eq(emails.userId, userId), sql`${emails.embedding} IS NULL`));

  if (unEmbedded.length === 0) return { embedded: 0 };

  let embedded = 0;

  for (let i = 0; i < unEmbedded.length; i += EMBED_BATCH_SIZE) {
    const batch = unEmbedded.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(
      (e) => ((e.subject ?? "") + "\n\n" + (e.bodyText ?? "")).slice(0, 8000),
    );

    try {
      const response = await getEmbeddingsClient().embeddings.create({
        model: getEmbeddingsModel(),
        input: texts,
      });

      const vectors = response.data.map((d: { embedding: number[] }) => d.embedding);

      for (let j = 0; j < batch.length; j++) {
        const vec = vectors[j];
        if (!vec) {
          console.warn(`[embeddings] no vector returned for email ${batch[j]!.id}, skipping`);
          continue;
        }

        try {
          await db
            .update(emails)
            .set({ embedding: vec })
            .where(eq(emails.id, batch[j]!.id));
        } catch (dbErr) {
          console.error(`[embeddings] DB update failed for email ${batch[j]!.id}:`, dbErr);
        }
      }

      embedded += batch.length;
    } catch (apiErr) {
      console.error(`[embeddings] API call failed for batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1}:`, apiErr);
      // Continue to next batch instead of aborting entirely
    }
  }

  return { embedded };
}

/**
 * Count emails that still need embeddings generated.
 * Used for the "Generate Embeddings (N pending)" UI badge.
 */
export async function getPendingEmbeddingsCount(
  userId: string,
): Promise<PendingEmbeddingsCount> {
  const result = await db
    .select({ pending: sql<number>`count(*)` })
    .from(emails)
    .where(and(eq(emails.userId, userId), sql`${emails.embedding} IS NULL`));

  return { pending: Number(result[0]?.pending ?? 0) };
}
