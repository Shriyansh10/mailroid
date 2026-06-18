import { corsair } from "@repo/corsair";
import { db, eq, sql, and, or, ilike } from "@repo/database";
import { emails } from "@repo/database/models/emails";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";
import { deriveCategory, deriveFlags, upsertMessageMetadata } from "./sync-metadata.ts";
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
} from "./model.ts";
import { createEmbedding, createEmbeddingsBatch, embedSearchQuery } from "@repo/ai";

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
    })
    .from(messageMetadata)
    .where(and(eq(messageMetadata.threadId, threadId), eq(messageMetadata.userId, tenantId)))
    .limit(1);

  if (meta[0]) {
    result.priority = meta[0].priority ?? undefined;
    result.priorityScore = meta[0].priorityScore ?? undefined;
    result.priorityReason = meta[0].priorityReason ?? undefined;
    result.isActionRequired = meta[0].isActionRequired ?? undefined;
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
export async function ingestMessage(
  tenantId: string,
  messageId: string,
  triggerEmbeddings = true
): Promise<void> {
  const startMs = Date.now();
  logger.info("[SERVICE] ingestMessage start", { tenantId, messageId });

  const tenant = corsair.withTenant(tenantId);

  // Fetch full message details
  const msg = await tenant.gmail.api.messages.get({
    id: messageId,
    format: "full",
  });

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
  if (flags.isUnread) {
    const { inngest } = await import("@repo/inngest");
    void inngest
      .send({
        name: "email.received",
        data: { userId: tenantId, entityId: messageId },
      })
      .catch((err) => {
        logger.error("[SERVICE] failed to send email.received event in ingestMessage", {
          tenantId,
          messageId,
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

  logger.info("[SERVICE] ingestMessage completed", { tenantId, messageId, durationMs: Date.now() - startMs });
}


/**
 * Sync the first 100 Gmail messages into local Postgres.
 * Batches 10 at a time. Idempotent — re-running updates existing rows.
 */
export async function syncEmails(tenantId: string, userId: string): Promise<SyncResult> {
  const startMs = Date.now();
  logger.info("[SERVICE] syncEmails start", { tenantId, userId });

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
        ingestMessage(tenantId, stub.id!, false).catch((err) =>
          logger.error("[DB] syncEmails upsert failed", { gmailMessageId: stub.id, error: String(err) })
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
 * Never crashes — always returns results or empty array.
 */
export async function searchLocalEmails(
  userId: string,
  query: string,
): Promise<LocalSearchResult> {
  try {
    const threads = await searchByEmbedding(userId, query, 20);
    if (threads.length > 0) {
        logger.info(
        `[search] ✅ Vector search — ${threads.length} results for "${query}"`,
        { userId, query, count: threads.length },
      );
      return { threads, total: threads.length };
    }
    // Vector search returned 0 results — try ILIKE as safety net
    logger.info(
      `[search] ⚠️ Vector search returned 0 results — falling back to ILIKE for "${query}"`,
      { userId, query },
    );
    return searchByText(userId, query);
  } catch (err) {
    logger.warn(
      `[search] ❌ Vector search failed — falling back to ILIKE for "${query}"`,
      { userId, query, err },
    );
    return searchByText(userId, query);
  }
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
): Promise<ThreadSummary[]> {
  const startMs = Date.now();
  logger.debug("[SEARCH] searchByEmbedding (pgvector)", { userId, query, limit });

  const queryVector = await embedSearchQuery(query);
  const vectorLiteral = `[${queryVector.join(",")}]`;

  const result = await db.execute<{
    gmail_message_id: string;
    thread_id: string;
    subject: string | null;
    from: string | null;
    snippet: string | null;
    received_at: Date | null;
  }>(
    sql`
      SELECT ${emails.gmailMessageId}, ${emails.threadId}, ${emails.subject}, ${emails.from}, ${emails.snippet}, ${emails.receivedAt}
      FROM ${emails}
      WHERE ${eq(emails.userId, userId)} AND ${emails.embedding} IS NOT NULL
      ORDER BY ${emails.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector`)} ASC
      LIMIT ${limit}
    `,
  );

  const threads = result.rows.map((r) => ({
    threadId: r.thread_id,
    sender: r.from ?? "",
    subject: r.subject ?? "(no subject)",
    date: r.received_at ? new Date(r.received_at).toISOString() : "",
    snippet: r.snippet ?? "",
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
): Promise<LocalSearchResult> {
  const startMs = Date.now();
  logger.debug("[SEARCH] searchByText (ILIKE fallback)", { userId, query });

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

/**
 * Generate embeddings for all emails that don't have one yet.
 * Batches 20 at a time using @repo/ai's createEmbeddingsBatch.
 * Idempotent — safe to re-run.
 */
export async function generateMissingEmbeddings(userId: string): Promise<EmbedResult> {
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

