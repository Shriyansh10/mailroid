import { db, eq, and, asc, inArray } from "@repo/database";
import { emails } from "@repo/database/models/emails";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";

import { listThreadAttachments } from "../attachments/store.ts";
import type { ThreadDetail, MessageDetail } from "./model.ts";

/**
 * Assemble a thread from what's already in Postgres, for when Gmail can't be
 * reached.
 *
 * The inbox list, drafts view and summariser are all served from local data
 * already — thread detail was the last read that *required* a live Gmail call,
 * which is why a rate-limited mailbox rendered a blank page rather than the
 * mail we were already holding.
 *
 * This is the DB-first half of apps/web/lib/summarize/thread-source.ts
 * (buildThreadSource), moved down into the service layer so getThread can use
 * it too.
 *
 * LIMITATION, and the reason the caller must label the result rather than pass
 * it off as live: `emails` stores `bodyText` only. There is no HTML, so a cached
 * thread is plain text and can be missing the newest replies. Renderable, but
 * visibly not the real thing — the UI says so.
 *
 * Attachments used to be part of that limitation and no longer are, with one
 * important qualification. `message_attachments` holds a manifest for any
 * message that was ever hydrated, so a cached thread can now list them. But a
 * message synced metadata-only never had a payload to parse, so it has no rows
 * — and NO ROWS DOES NOT MEAN NO ATTACHMENTS. Those messages carry `null`,
 * which the UI must render as *unknown*. Reporting "no attachments" for a
 * message we simply never opened would be a confident lie about someone's mail.
 */
export async function buildThreadFromDb(
  tenantId: string,
  threadId: string,
): Promise<ThreadDetail | null> {
  const rows = await db
    .select({
      gmailMessageId: emails.gmailMessageId,
      subject: emails.subject,
      from: emails.from,
      to: emails.to,
      snippet: emails.snippet,
      bodyText: emails.bodyText,
      receivedAt: emails.receivedAt,
      lastSyncedAt: emails.lastSyncedAt,
      updatedAt: emails.updatedAt,
    })
    .from(emails)
    // Hits idx_emails_user_thread.
    .where(and(eq(emails.userId, tenantId), eq(emails.threadId, threadId)))
    .orderBy(asc(emails.receivedAt));

  // No local copy: the caller must rethrow the original Gmail error. An empty
  // thread would look like "this conversation is gone", which is a different
  // and much worse claim than "we couldn't reach Gmail".
  if (rows.length === 0) return null;

  const ids = rows.map((r) => r.gmailMessageId);
  const metaRows = await db
    .select({
      entityId: messageMetadata.entityId,
      draftId: messageMetadata.draftId,
      snippet: messageMetadata.snippet,
      // There is no is_draft column — draft-ness lives in Gmail's own labels,
      // the same source transformThreadDetail reads on the live path.
      gmailLabels: messageMetadata.gmailLabels,
    })
    .from(messageMetadata)
    .where(and(eq(messageMetadata.userId, tenantId), inArray(messageMetadata.entityId, ids)));
  const metaById = new Map(metaRows.map((m) => [m.entityId, m]));

  // Which messages we actually have a manifest for. A message absent from this
  // map was never hydrated, so its attachment state is unknown rather than
  // empty — the distinction the header comment above turns on.
  const attachmentRows = await listThreadAttachments(tenantId, threadId).catch((err: unknown) => {
    // A manifest read failing must not sink the fallback that exists precisely
    // because something else already failed. Everything reports unknown.
    logger.warn("[ATTACHMENTS] manifest read failed on cached thread", {
      tenantId, threadId, error: String(err),
    });
    return [];
  });

  const attachmentsByMessage = new Map<string, MessageDetail["attachments"]>();
  for (const row of attachmentRows) {
    if (row.isInline) continue; // body furniture, not documents
    const list = attachmentsByMessage.get(row.gmailMessageId) ?? [];
    list!.push({
      id: row.id,
      partId: row.partId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      cached: row.cacheStorageKey !== null,
    });
    attachmentsByMessage.set(row.gmailMessageId, list);
  }
  // A hydrated message with only inline parts has rows but no visible
  // attachments — genuinely "none", not "unknown". Seed those explicitly.
  for (const row of attachmentRows) {
    if (!attachmentsByMessage.has(row.gmailMessageId)) {
      attachmentsByMessage.set(row.gmailMessageId, []);
    }
  }

  const messages: MessageDetail[] = rows.map((r) => {
    const meta = metaById.get(r.gmailMessageId);
    const isDraft = Array.isArray(meta?.gmailLabels)
      ? (meta.gmailLabels as string[]).includes("DRAFT")
      : false;
    return {
      id: r.gmailMessageId,
      from: r.from ?? "",
      to: r.to ?? "",
      subject: r.subject ?? "",
      date: (r.receivedAt ?? r.updatedAt).toISOString(),
      body: r.bodyText ?? "",
      // Deliberately empty rather than a synthesised <pre> wrapper: the view
      // falls back to `body`, and inventing markup we never stored would make
      // the cached copy look more complete than it is.
      //
      // `inlineImages` is omitted for the same reason and is not an oversight:
      // it exists only to resolve `cid:` references inside htmlBody, and there
      // is no htmlBody on this path. The live read populates it.
      htmlBody: "",
      snippet: r.snippet ?? meta?.snippet ?? "",
      // null, not [] — see the header note. `??` rather than a `has` check
      // would be wrong here only if [] were falsy; it isn't, so an explicitly
      // seeded empty array survives and a genuinely absent manifest becomes
      // null.
      attachments: attachmentsByMessage.get(r.gmailMessageId) ?? null,
      ...(isDraft ? { isDraft: true } : {}),
      ...(meta?.draftId ? { draftId: meta.draftId } : {}),
    };
  });

  // Oldest non-empty subject wins, matching how Gmail titles a conversation.
  const subject = rows.find((r) => r.subject)?.subject ?? "";

  // How stale is this, really? The most recent sync across the thread — that's
  // the honest "as of" the banner shows the user.
  const cachedAt = rows.reduce<Date | null>((latest, r) => {
    const t = r.lastSyncedAt ?? r.updatedAt;
    return !latest || t > latest ? t : latest;
  }, null);

  logger.info("[SERVICE] serving thread from local cache", {
    tenantId, threadId, messageCount: messages.length, cachedAt: cachedAt?.toISOString(),
  });

  return {
    threadId,
    subject,
    messages,
    source: "cache",
    cachedAt: cachedAt?.toISOString() ?? null,
  };
}
