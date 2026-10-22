/**
 * Attachment DISCOVERY for Dobbie: finding files by name, type, sender and
 * date, from metadata alone.
 *
 * Nothing here reads bytes, calls Gmail, or returns anything that grants
 * access: an attachment id in a result is opened through /api/attachments/[id],
 * which re-checks ownership itself. Authorization lives in the SQL — every
 * query is constrained to the session's user on EVERY table it touches, never
 * filtered afterwards.
 *
 * COMPLETENESS is read from `attachment_manifest_at`, not from whether rows
 * exist. replaceAttachmentManifest (the only production writer) writes the
 * rows and the stamp in one transaction, so a stamped message has a complete
 * list — possibly empty — and an unstamped one has none yet.
 */
import { db, and, eq, sql, type SQL } from "@repo/database";
import { messageAttachments } from "@repo/database/models/message-attachments";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { FAMILY_RULES, type FileFamily } from "./file-family.ts";

// ── One message's files, or "unknown" ───────────────────────────────────

export interface KnownAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * The visible (non-inline) attachments of one message — or null when nobody
 * has checked. Never `[]` for "unknown": an empty list is a statement that the
 * message has no files, and the assistant repeats it to the user.
 *
 * Known when the manifest was stamped, when the header heuristic already said
 * "no" (has_attachment = false), or when rows exist at all (older manifests).
 */
export async function getMessageAttachmentManifest(
  userId: string,
  entityId: string,
): Promise<KnownAttachment[] | null> {
  const [meta] = await db
    .select({
      manifestAt: messageMetadata.attachmentManifestAt,
      hasAttachment: messageMetadata.hasAttachment,
    })
    .from(messageMetadata)
    .where(and(eq(messageMetadata.userId, userId), eq(messageMetadata.entityId, entityId)));

  const rows = await db
    .select({
      id: messageAttachments.id,
      filename: messageAttachments.filename,
      mimeType: messageAttachments.mimeType,
      sizeBytes: messageAttachments.sizeBytes,
      isInline: messageAttachments.isInline,
    })
    .from(messageAttachments)
    .where(and(eq(messageAttachments.userId, userId), eq(messageAttachments.gmailMessageId, entityId)));

  const known = meta?.manifestAt != null || meta?.hasAttachment === false || rows.length > 0;
  if (!known) return null;
  return rows
    .filter((row) => !row.isInline)
    .map(({ id, filename, mimeType, sizeBytes }) => ({ id, filename, mimeType, sizeBytes }));
}

// ── Search ──────────────────────────────────────────────────────────────

export interface AttachmentSearchFilters {
  /** Substring of the filename, case-insensitive. */
  filename?: string;
  family?: FileFamily;
  /** Substring of the From header, case-insensitive — searchEmails' sender rule. */
  sender?: string;
  withinDays?: number;
  limit: number;
}

export interface FoundAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  entityId: string;
  threadId: string | null;
  receivedAt: Date | null;
  sender: string | null;
}

/** A user's text as a literal ILIKE substring: `%` and `_` match themselves. */
export function likeSubstring(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function windowStart(withinDays?: number, now: Date = new Date()): Date | null {
  if (withinDays == null || !Number.isFinite(withinDays) || withinDays <= 0) return null;
  return new Date(now.getTime() - withinDays * 24 * 60 * 60 * 1000);
}

/** SQL for "this attachment is of `family`", from the same rule the UI icon uses. */
export function familyCondition(family: FileFamily): SQL {
  const rule = FAMILY_RULES[family];
  const clauses: SQL[] = [];
  if (rule.mimePrefix) clauses.push(sql`lower(${messageAttachments.mimeType}) LIKE ${`${rule.mimePrefix}%`}`);
  for (const mime of rule.mimes ?? []) clauses.push(sql`lower(${messageAttachments.mimeType}) = ${mime}`);
  for (const ext of rule.exts) clauses.push(sql`lower(${messageAttachments.filename}) LIKE ${`%.${ext}`}`);
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

/** Sender and window, against message_metadata — shared by search, senders and coverage. */
function messageScope(userId: string, f: Pick<AttachmentSearchFilters, "sender" | "withinDays">): SQL[] {
  const scope: SQL[] = [sql`${messageMetadata.userId} = ${userId}`];
  if (f.sender?.trim()) scope.push(sql`${messageMetadata.sender} ILIKE ${likeSubstring(f.sender.trim())}`);
  const since = windowStart(f.withinDays);
  if (since) scope.push(sql`${messageMetadata.receivedAt} >= ${since}`);
  return scope;
}

/**
 * The WHERE clause for a file search. Exported so its shape — the user on BOTH
 * tables, inline parts excluded — is pinned by a test without a database.
 */
export function findAttachmentsWhere(userId: string, f: AttachmentSearchFilters): SQL {
  const clauses: SQL[] = [
    sql`${messageAttachments.userId} = ${userId}`,
    ...messageScope(userId, f),
    sql`${messageAttachments.isInline} = false`,
  ];
  if (f.filename?.trim()) {
    clauses.push(sql`${messageAttachments.filename} ILIKE ${likeSubstring(f.filename.trim())}`);
  }
  if (f.family) clauses.push(familyCondition(f.family));
  return sql.join(clauses, sql` AND `);
}

export async function findAttachments(userId: string, f: AttachmentSearchFilters): Promise<FoundAttachment[]> {
  const rows = await db
    .select({
      attachmentId: messageAttachments.id,
      filename: messageAttachments.filename,
      mimeType: messageAttachments.mimeType,
      sizeBytes: messageAttachments.sizeBytes,
      entityId: messageAttachments.gmailMessageId,
      threadId: messageAttachments.threadId,
      receivedAt: messageMetadata.receivedAt,
      sender: messageMetadata.sender,
    })
    .from(messageAttachments)
    // Joined on the message AND the user: a message id is only ever looked up
    // inside the caller's own mailbox.
    .innerJoin(
      messageMetadata,
      and(
        eq(messageMetadata.entityId, messageAttachments.gmailMessageId),
        eq(messageMetadata.userId, messageAttachments.userId),
      ),
    )
    .where(findAttachmentsWhere(userId, f))
    .orderBy(sql`${messageMetadata.receivedAt} DESC NULLS LAST`)
    .limit(Math.max(1, Math.min(f.limit, 20)));
  return rows;
}

/**
 * Distinct From headers matching `sender` in the window — whether the name the
 * user gave means nobody, one person, or several. Capped: this answers "is it
 * ambiguous", it is not a contact list.
 */
export async function findMatchingSenders(
  userId: string,
  f: Pick<AttachmentSearchFilters, "sender" | "withinDays">,
): Promise<string[]> {
  if (!f.sender?.trim()) return [];
  const rows = await db
    .selectDistinct({ sender: messageMetadata.sender })
    .from(messageMetadata)
    .where(sql.join(messageScope(userId, f), sql` AND `))
    .limit(25);
  return rows.map((r) => r.sender).filter((s): s is string => !!s);
}

export interface AttachmentCoverage {
  /** Messages known to carry attachments whose list isn't stored yet. */
  awaitingList: number;
  /** Messages nobody has checked at all. */
  unknownStatus: number;
}

/**
 * The SQL for coverage. message_metadata alone, one row per message, so a
 * message with several attachments can never be counted more than once.
 */
export function coverageQuery(userId: string, f: Pick<AttachmentSearchFilters, "sender" | "withinDays">): SQL {
  const scope = sql.join(messageScope(userId, f), sql` AND `);
  return sql`
    SELECT
      count(DISTINCT ${messageMetadata.entityId}) FILTER (WHERE ${messageMetadata.hasAttachment} IS TRUE)::int AS awaiting_list,
      count(DISTINCT ${messageMetadata.entityId}) FILTER (WHERE ${messageMetadata.hasAttachment} IS NULL)::int AS unknown_status
    FROM ${messageMetadata}
    WHERE ${scope} AND ${messageMetadata.attachmentManifestAt} IS NULL
  `;
}

export async function attachmentSearchCoverage(
  userId: string,
  f: Pick<AttachmentSearchFilters, "sender" | "withinDays">,
): Promise<AttachmentCoverage> {
  const result = await db.execute<{ awaiting_list: number; unknown_status: number }>(coverageQuery(userId, f));
  const row = result.rows[0];
  return { awaitingList: Number(row?.awaiting_list ?? 0), unknownStatus: Number(row?.unknown_status ?? 0) };
}
