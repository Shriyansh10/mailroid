/**
 * Draft lifecycle — two-way with Gmail.
 *
 * Drafts are the one mailbox view that is NOT just a label query. Gmail models
 * a draft as its own resource with its own id, wrapping a message that also has
 * an id, and only the *draft* id can be updated or sent. That id is not
 * derivable from the message, so it is synced into `message_metadata.draft_id`
 * and read back whenever the user edits or sends.
 *
 * Everything here writes to Gmail first and mirrors locally second, so a failed
 * Gmail call never leaves the local DB claiming a draft exists that doesn't.
 */

import { corsair } from "@repo/corsair";
import { db, and, eq } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";

import { buildRawEmail, extractBody, getHeader, resolveReplyTarget } from "./index.ts";
import type { MessagePart, PayloadHeader } from "./index.ts";
import { mapWithConcurrency, upsertMessageMetadataBatch } from "./sync-metadata.ts";
import type { MetadataInput } from "./sync-metadata.ts";
import { withGmailRetry } from "./retry.ts";

export interface DraftInput {
  to: string;
  /**
   * Comma-separated, written straight into the draft's headers. Bcc survives
   * here and nowhere else in the app: Gmail keeps the header on an unsent
   * draft (so getDraft can read it back) and strips it the moment the draft is
   * sent, which is exactly the behaviour a blind copy needs.
   */
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** Set when the draft is a reply, so Gmail keeps it in the same thread. */
  threadId?: string;
  /**
   * The message being replied to, when this draft is a reply/reply-all —
   * used ONLY to derive the In-Reply-To/References headers (same resolution
   * replyToEmail uses for a real send), never the recipient. Without this,
   * a reply saved as a draft has no way to signal it's a reply: threadId
   * alone groups it into the conversation but leaves In-Reply-To unset, which
   * is exactly what getDraft's isReplyToExisting check reads — so an
   * unheadered reply-draft would wrongly reopen as a fresh compose instead of
   * resuming inline in its thread.
   */
  entityId?: string;
  replyAll?: boolean;
}

export interface DraftDetail extends DraftInput {
  draftId: string;
  messageId: string;
  /**
   * True when this draft was created as a reply/reply-all (its underlying
   * message carries an In-Reply-To header) rather than a fresh compose.
   * Read directly off the header array `getDraft` already fetches — no extra
   * query. This is what lets a draft click navigate to the original
   * conversation instead of just reopening a blank-context compose modal:
   * a thread's current message count can't answer this reliably (a later
   * archive/delete undercounts it; an unrelated auto-threaded message
   * overcounts it), but In-Reply-To is set once, at reply-creation time, and
   * never changes underneath it.
   */
  isReplyToExisting: boolean;
}

interface RawDraft {
  id?: string;
  message?: {
    id?: string;
    threadId?: string;
    labelIds?: string[];
    snippet?: string;
    internalDate?: string;
    payload?: MessagePart;
  };
}

/** Build the message_metadata row for a draft, carrying its draft id. */
function buildDraftRow(userId: string, draft: RawDraft): MetadataInput | null {
  const msg = draft.message;
  if (!draft.id || !msg?.id) return null;

  const headers = (msg.payload?.headers ?? []) as PayloadHeader[];
  const internalDate = Number(msg.internalDate);

  return {
    entityId: msg.id,
    userId,
    gmailLabels: msg.labelIds ?? ["DRAFT"],
    // A draft always lands in the DRAFT category regardless of what other
    // labels it carries — that's what makes the Draft view a plain category
    // read like every other view.
    category: "DRAFT",
    sender: getHeader(headers, "From"),
    subject: getHeader(headers, "Subject"),
    snippet: msg.snippet ?? "",
    // A draft is your own unsent text: never unread, never in the inbox.
    isUnread: false,
    isInInbox: false,
    isStarred: false,
    isImportant: false,
    receivedAt: isNaN(internalDate) ? new Date() : new Date(internalDate),
    threadId: msg.threadId,
    draftId: draft.id,
  };
}

/**
 * Sync one page of drafts. Mirrors syncCategoryPage's contract (returns the
 * next page token) so the durable per-page sync loop can drive it unchanged.
 */
export async function syncDraftsPage(
  userId: string,
  pageToken?: string,
): Promise<{ processed: number; nextPageToken?: string }> {
  const tenant = corsair.withTenant(userId);

  // tenantId and trigger were BOTH missing here. Without tenantId the pre-flight
  // cooldown gate never ran, the ledger booked these as "unattributed", and —
  // now that pacing hangs off the same argument — they would have been paced
  // against a shared bucket instead of this mailbox's own. `userId` was in scope
  // the whole time.
  const result = await withGmailRetry<{
    drafts?: Array<{ id?: string }>;
    nextPageToken?: string | null;
  }>(
    "drafts.list",
    () => tenant.gmail.api.drafts.list({ maxResults: 100, pageToken }),
    { tenantId: userId, trigger: "sync" },
  );

  const stubs = (result.drafts ?? []).filter((d) => d.id);
  if (stubs.length === 0) {
    return { processed: 0, nextPageToken: result.nextPageToken ?? undefined };
  }

  // drafts.list returns ids only — the headers we display come from a per-draft
  // get, same shape as the thread sync's threads.get fan-out.
  //
  // BOUNDED, not Promise.all. drafts.get is 20 units, so a full 100-draft page
  // fired at once reserves 2,000 units — the last of which lands ~26 seconds
  // out and would be refused outright on any capped trigger. It is also the
  // per-user CONCURRENT REQUEST limit, which is a separate Gmail control from
  // the quota budget.
  const detailed = await mapWithConcurrency(stubs, 4, (d) =>
    withGmailRetry<RawDraft>(
      `drafts.get ${d.id}`,
      () => tenant.gmail.api.drafts.get({ id: d.id!, format: "metadata" }),
      { tenantId: userId, trigger: "sync" },
    ).catch((err) => {
      logger.error("[SYNC] drafts.get failed, skipping", {
        userId, draftId: d.id, error: String(err),
      });
      return null;
    }),
  );

  const rows = detailed
    .map((d) => (d ? buildDraftRow(userId, d) : null))
    .filter((r): r is MetadataInput => r !== null);

  await upsertMessageMetadataBatch(rows);

  logger.info("[SYNC] syncDraftsPage completed", { userId, processed: rows.length });
  return { processed: rows.length, nextPageToken: result.nextPageToken ?? undefined };
}

/** Re-fetch a single draft from Gmail and mirror it locally. */
async function ingestDraft(userId: string, draftId: string): Promise<void> {
  const tenant = corsair.withTenant(userId);
  const draft = (await withGmailRetry<RawDraft>(
    `drafts.get ${draftId}`,
    () => tenant.gmail.api.drafts.get({ id: draftId, format: "metadata" }) as Promise<RawDraft>,
    { tenantId: userId, trigger: "ui" },
  )) as RawDraft;

  const row = buildDraftRow(userId, draft);
  if (row) await upsertMessageMetadataBatch([row]);
}

/**
 * Full draft contents for the compose dialog to reopen. Uses format "full"
 * (not "metadata") because the editor needs the body, not just the headers.
 */
export async function getDraft(userId: string, draftId: string): Promise<DraftDetail> {
  const tenant = corsair.withTenant(userId);
  const draft = (await withGmailRetry<RawDraft>(
    `drafts.get ${draftId}`,
    () => tenant.gmail.api.drafts.get({ id: draftId, format: "full" }) as Promise<RawDraft>,
    { tenantId: userId, trigger: "ui" },
  )) as RawDraft;

  const msg = draft.message;
  const headers = (msg?.payload?.headers ?? []) as PayloadHeader[];

  return {
    draftId,
    messageId: msg?.id ?? "",
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc") || undefined,
    bcc: getHeader(headers, "Bcc") || undefined,
    subject: getHeader(headers, "Subject"),
    body: extractBody(msg?.payload),
    threadId: msg?.threadId,
    isReplyToExisting: Boolean(getHeader(headers, "In-Reply-To")),
  };
}

/** Resolves In-Reply-To/References for a reply-shaped draft, when its target message is given. */
async function resolveDraftReplyHeaders(
  userId: string,
  input: DraftInput,
): Promise<{ inReplyTo?: string; references?: string }> {
  if (!input.entityId) return {};
  const target = await resolveReplyTarget(userId, input.entityId, input.replyAll);
  return { inReplyTo: target.messageId || undefined, references: target.references || undefined };
}

export async function createDraft(
  userId: string,
  input: DraftInput,
): Promise<{ draftId: string }> {
  const tenant = corsair.withTenant(userId);
  const headers = await resolveDraftReplyHeaders(userId, input);
  const raw = buildRawEmail(input.to, input.subject, input.body, {
    ...headers,
    cc: input.cc?.trim() || undefined,
    bcc: input.bcc?.trim() || undefined,
  });

  const draft = (await withGmailRetry<RawDraft>(
    "drafts.create",
    () =>
      tenant.gmail.api.drafts.create({
        draft: { message: { raw, threadId: input.threadId } },
      }) as Promise<RawDraft>,
    { tenantId: userId, trigger: "ui" },
  )) as RawDraft;

  if (!draft.id) throw new Error("Gmail did not return a draft id");

  await ingestDraft(userId, draft.id);
  logger.info("[SERVICE] createDraft completed", { userId, draftId: draft.id });
  return { draftId: draft.id };
}

export async function updateDraft(
  userId: string,
  draftId: string,
  input: DraftInput,
): Promise<{ draftId: string }> {
  const tenant = corsair.withTenant(userId);
  const headers = await resolveDraftReplyHeaders(userId, input);
  const raw = buildRawEmail(input.to, input.subject, input.body, {
    ...headers,
    cc: input.cc?.trim() || undefined,
    bcc: input.bcc?.trim() || undefined,
  });

  await withGmailRetry(
    `drafts.update ${draftId}`,
    () =>
      tenant.gmail.api.drafts.update({
        id: draftId,
        draft: { message: { raw, threadId: input.threadId } },
      }),
    { tenantId: userId, trigger: "ui" },
  );

  await ingestDraft(userId, draftId);
  logger.info("[SERVICE] updateDraft completed", { userId, draftId });
  return { draftId };
}

/**
 * Send a draft. Gmail consumes the draft in the process — it stops existing and
 * becomes a sent message — so the local DRAFT row is dropped rather than
 * updated. The sent copy arrives through the normal SENT sync.
 */
export async function sendDraft(
  userId: string,
  draftId: string,
): Promise<{ id: string; threadId: string }> {
  const tenant = corsair.withTenant(userId);
  // trigger "send", not "ui": a person pressed Send, so this gets the 10s send
  // cap rather than the 2s interactive one. Failing a send outright because a
  // background sync held the schedule would be worse than a short wait.
  const sent = (await withGmailRetry<{ id?: string; threadId?: string }>(
    "drafts.send",
    () =>
      tenant.gmail.api.drafts.send({ id: draftId }) as Promise<{
        id?: string;
        threadId?: string;
      }>,
    { tenantId: userId, trigger: "send" },
  )) as { id?: string; threadId?: string };

  await deleteLocalDraft(userId, draftId);
  logger.info("[SERVICE] sendDraft completed", { userId, draftId, messageId: sent.id });
  return { id: sent.id ?? "", threadId: sent.threadId ?? "" };
}

/** Discard a draft in Gmail and locally. */
export async function discardDraft(userId: string, draftId: string): Promise<void> {
  const tenant = corsair.withTenant(userId);
  await withGmailRetry(
    `drafts.delete ${draftId}`,
    () => tenant.gmail.api.drafts.delete({ id: draftId }),
    { tenantId: userId, trigger: "ui" },
  );
  await deleteLocalDraft(userId, draftId);
  logger.info("[SERVICE] discardDraft completed", { userId, draftId });
}

/**
 * Drops the local mirror of a draft that no longer exists in Gmail.
 *
 * This is a genuine delete, not the is_archived hide used for purged mail: a
 * draft that was sent or discarded has no content worth retaining — the sent
 * copy is synced separately, and a discarded draft was never sent to anyone.
 */
async function deleteLocalDraft(userId: string, draftId: string): Promise<void> {
  await db
    .delete(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.draftId, draftId),
      ),
    );
}
