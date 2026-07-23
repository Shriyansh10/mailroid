import type { ToolExecutor } from "@repo/ai";
import { createEmbeddingsBatch, embedSearchQuery, ToolExecutionError } from "@repo/ai";
import { db, eq, and, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { emailChunks } from "@repo/database/models/email-chunks";
import { getOrCreateSummary } from "@web/lib/summarize/get-or-create-summary";
import { getProtectedConfig } from "@repo/services/profile/index";
import { matchProtectedSender, matchProtectedKeyword } from "@repo/shared";

export interface GetEmailDetailInput {
  entityId: string;
  query: string;
}

export interface EmailDetailPassage {
  text: string;
  score: number;
}

export interface GetEmailDetailOutput {
  found: boolean;
  passages?: EmailDetailPassage[];
  truncated?: boolean;
  message?: string;
}

// Semantic boundaries beat a fixed token/char window; overlap keeps a detail
// from being split exactly across a chunk edge.
const CHUNK_TARGET_CHARS = 800;
const CHUNK_OVERLAP_RATIO = 0.15;
const RESULT_CHAR_CAP = 1500;
const TOP_K = 3;

/**
 * Splits guardrailed email text into overlapping chunks for embedding.
 * Packs whole paragraphs up to the target size; a paragraph with no natural
 * break bigger than the target is hard-sliced with overlap rather than
 * becoming one oversized, poorly-matchable chunk.
 */
function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  const pieces: string[] = [];
  const hardSliceStep = Math.floor(CHUNK_TARGET_CHARS * (1 - CHUNK_OVERLAP_RATIO));
  for (const para of paragraphs) {
    if (para.length <= CHUNK_TARGET_CHARS * 1.5) {
      pieces.push(para);
      continue;
    }
    for (let i = 0; i < para.length; i += hardSliceStep) {
      pieces.push(para.slice(i, i + CHUNK_TARGET_CHARS));
      if (i + CHUNK_TARGET_CHARS >= para.length) break;
    }
  }

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > CHUNK_TARGET_CHARS) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/**
 * Builds this email's chunk index the first time it's needed, from
 * message_metadata.summary_full_text (the guardrailed, uncompressed body —
 * PII masked, secrets redacted, links neutralized, never the raw email).
 * Decoupled from the summarize pipeline itself: only requires
 * summary_full_text to exist, calling getOrCreateSummary to produce it if
 * it doesn't (charge:"never" — the chat route already charges once per
 * turn). No-ops if chunks already exist for this email.
 */
export async function ensureEmailChunks(userId: string, entityId: string): Promise<void> {
  const [existing] = await db
    .select({ id: emailChunks.id })
    .from(emailChunks)
    .where(and(eq(emailChunks.userId, userId), eq(emailChunks.entityId, entityId)))
    .limit(1);
  if (existing) return;

  const [meta] = await db
    .select({ summaryFullText: messageMetadata.summaryFullText })
    .from(messageMetadata)
    .where(and(eq(messageMetadata.entityId, entityId), eq(messageMetadata.userId, userId)))
    .limit(1);

  let fullText = meta?.summaryFullText ?? null;
  if (!fullText) {
    const outcome = await getOrCreateSummary({ userId, entityId, charge: "never" });
    if (!outcome.ok) return;
    fullText = outcome.fullText;
  }
  if (!fullText?.trim()) return;

  const pieces = chunkText(fullText);
  if (pieces.length === 0) return;

  const embeddings = await createEmbeddingsBatch(pieces);
  await db.insert(emailChunks).values(
    pieces.map((text, i) => ({
      userId,
      entityId,
      chunkIndex: i,
      text,
      embedding: embeddings[i]!,
    })),
  );
}

async function searchEmailChunks(
  userId: string,
  entityId: string,
  query: string,
  limit: number,
): Promise<EmailDetailPassage[]> {
  const queryVector = await embedSearchQuery(query);
  const vectorLiteral = `[${queryVector.join(",")}]`;

  const result = await db.execute<{ text: string; distance: number }>(
    sql`
      SELECT ${emailChunks.text},
        ${emailChunks.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector`)} AS distance
      FROM ${emailChunks}
      WHERE ${eq(emailChunks.userId, userId)} AND ${eq(emailChunks.entityId, entityId)} AND ${emailChunks.embedding} IS NOT NULL
      ORDER BY distance ASC
      LIMIT ${limit}
    `,
  );

  return result.rows.map((r) => ({
    text: r.text,
    score: Math.max(0, Math.min(1, 1 - Number(r.distance))),
  }));
}

/**
 * Production executor for getEmailDetail. Caps total returned text at
 * RESULT_CHAR_CAP — this exists specifically so a detail lookup can never
 * reintroduce the whole-body-in-context problem it was built to solve.
 */
export class GetEmailDetailExecutor
  implements ToolExecutor<GetEmailDetailInput, GetEmailDetailOutput>
{
  async execute(
    args: GetEmailDetailInput,
    ctx: { userId: string; requestId: string },
  ): Promise<GetEmailDetailOutput> {
    const { userId } = ctx;

    const [meta] = await db
      .select({
        entityId: messageMetadata.entityId,
        sender: messageMetadata.sender,
        subject: messageMetadata.subject,
        snippet: messageMetadata.snippet,
      })
      .from(messageMetadata)
      .where(and(eq(messageMetadata.entityId, args.entityId), eq(messageMetadata.userId, userId)))
      .limit(1);

    if (!meta) {
      return { found: false, message: "No email with that id in this mailbox." };
    }

    // Blocklist: refuse to read a protected email's contents.
    const blocklist = await getProtectedConfig(userId);
    if (
      matchProtectedSender(meta.sender, blocklist.senders) ||
      matchProtectedKeyword(`${meta.subject ?? ""}\n${meta.snippet ?? ""}`, blocklist.keywords)
    ) {
      throw new ToolExecutionError(
        "getEmailDetail",
        new Error("That email is on your protected list, so I can't read its contents."),
      );
    }

    await ensureEmailChunks(userId, args.entityId);

    const passages = await searchEmailChunks(userId, args.entityId, args.query, TOP_K);
    if (passages.length === 0) {
      return { found: false, message: "That email has no content to search, or nothing matched." };
    }

    const capped: EmailDetailPassage[] = [];
    let total = 0;
    let truncated = false;
    for (const p of passages) {
      if (total + p.text.length > RESULT_CHAR_CAP) {
        const remaining = RESULT_CHAR_CAP - total;
        if (remaining > 100) capped.push({ text: p.text.slice(0, remaining) + "…", score: p.score });
        truncated = true;
        break;
      }
      capped.push(p);
      total += p.text.length;
    }

    return { found: true, passages: capped, truncated: truncated || capped.length < passages.length };
  }
}
