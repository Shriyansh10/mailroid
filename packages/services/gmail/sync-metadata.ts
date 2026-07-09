import { corsair } from "@repo/corsair";
import { db } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";

import {CATEGORY_TO_GMAIL_QUERY, ALL_CATEGORIES, extractHeader} from './metadata.ts';
import { withGmailRetry } from './retry.ts';

// ── Category mapping ──────────────────────────────────────────────────

const LABEL_TO_CATEGORY: Record<string, string> = {
  SENT: "SENT",
  DRAFT: "DRAFT",
  SPAM: "SPAM",
  TRASH: "TRASH",

  CATEGORY_PERSONAL: "PRIMARY",

  CATEGORY_PROMOTIONS: "PROMOTIONS",
  CATEGORY_SOCIAL: "SOCIAL",
  CATEGORY_UPDATES: "UPDATES",
  CATEGORY_FORUMS: "FORUMS",
};

export function deriveCategory(labels: string[]): string {
  if (!Array.isArray(labels) || labels.length === 0) {
    logger.debug("[CATEGORY] deriveCategory - no labels, returning OTHER");
    return "OTHER";
  }
  for (const label of labels) {
    const match = LABEL_TO_CATEGORY[label];
    if (match) {
      return match;
    }
  }
  logger.debug("[CATEGORY] deriveCategory - no match in known labels, returning OTHER", { labels });
  return "OTHER";
}

// ── Flag derivation ───────────────────────────────────────────────────

export function deriveFlags(labels: string[]): {
  isUnread: boolean;
  isInInbox: boolean;
  isStarred: boolean;
  isImportant: boolean;
} {
  const set = new Set(labels ?? []);
  const flags = {
    isUnread: set.has("UNREAD"),
    isInInbox: set.has("INBOX"),
    isStarred: set.has("STARRED"),
    isImportant: set.has("IMPORTANT"),
  };
  return flags;
}

// ── Upsert ────────────────────────────────────────────────────────────

interface MetadataInput {
  entityId: string;
  userId: string;
  gmailLabels: string[];
  category: string;
  isUnread: boolean;
  sender?: string;
subject?: string;
snippet?: string;
  isInInbox: boolean;
  isStarred: boolean;
  isImportant: boolean;
  receivedAt?: Date;
  threadId?: string;
}

export async function upsertMessageMetadata(input: MetadataInput): Promise<void> {
  await db
    .insert(messageMetadata)
    .values({
      entityId: input.entityId,
      userId: input.userId,
      gmailLabels: input.gmailLabels,
      category: input.category as any,
      sender: input.sender,
subject: input.subject,
snippet: input.snippet,
      isUnread: input.isUnread,
      isInInbox: input.isInInbox,
      isStarred: input.isStarred,
      isImportant: input.isImportant,
      receivedAt: input.receivedAt,
      threadId: input.threadId,
    })
    .onConflictDoUpdate({
      target: messageMetadata.entityId,
      set: {
        userId: input.userId,
        gmailLabels: input.gmailLabels,
        category: input.category as any,
        sender: input.sender,
subject: input.subject,
snippet: input.snippet,
        isUnread: input.isUnread,
        isInInbox: input.isInInbox,
        isStarred: input.isStarred,
        isImportant: input.isImportant,
        receivedAt: input.receivedAt,
        threadId: input.threadId,
        updatedAt: new Date(),
      },
    });
  logger.debug("[DB] upsertMessageMetadata completed", {
    entityId: input.entityId, category: input.category, userId: input.userId,
  });
}

// ── Single pipeline entry point ───────────────────────────────────────

export async function processMessage(
  userId: string,
  entityId: string,
): Promise<void> {
  const gmailStart = Date.now();
  const tenant = corsair.withTenant(userId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = await withGmailRetry(`messages.get ${entityId}`, () =>
    (tenant.gmail.api as any).messages.get({
      userId: "me",
      id: entityId,
      format: "full",
    }),
  );
  // Gmail API returns labelIds directly on the message object, not nested
  const raw = msg as Record<string, unknown>;
  const sender = extractHeader(raw, "From");
const subject = extractHeader(raw, "Subject");
const snippet = (raw.snippet as string) ?? "";
  const labels: string[] = (raw.labelIds as string[]) ?? [];
  const internalDate = Number(raw.internalDate);
  const receivedAt = isNaN(internalDate) ? undefined : new Date(internalDate);
  const threadId = raw.threadId as string | undefined;
  const category = deriveCategory(labels);
  const flags = deriveFlags(labels);

  logger.debug("[CATEGORY] processMessage classification", {
    entityId, userId, labels, category, flags, threadId, receivedAt,
    gmailDurationMs: Date.now() - gmailStart,
  });

  await upsertMessageMetadata({
    entityId,
    userId,
    gmailLabels: labels,
    sender,
subject,
snippet,
    category,
    ...flags,
    receivedAt,
    threadId,
  });

  // Trigger priority classification
  if (flags.isUnread) {
    const { inngest } = await import("@repo/inngest");
    await inngest.send({
      name: "email.received",
      data: { userId, entityId },
    });
  }
}

export async function processMessages(
  userId: string,
  entityIds: string[],
): Promise<void> {
    
  logger.info("[SERVICE] processMessages batch", { userId, entityCount: entityIds.length });
  await Promise.all(
    entityIds.map((id) =>
      processMessage(userId, id).catch((err) =>
        logger.error("[CATEGORY] processMessage failed", { entityId: id, userId, error: String(err) }),
      ),
    ),
  );
  logger.info("[SERVICE] processMessages batch completed", { userId, entityCount: entityIds.length });
}


// Gmail's per-user quota is 250 units/sec and threads.get costs 5 units, so
// firing all ~100 threads per page at once (500 units) reliably triggers 429s.
// A single rejected call in Promise.all previously aborted the whole
// syncAllEmails call (and therefore the rest of pagination) — this limiter
// caps concurrency and isolates per-thread failures so one bad/rate-limited
// thread just gets skipped (and logged) instead of truncating the sync.
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await fn(items[current]!);
      } catch (err) {
        logger.error("[SYNC] thread fetch failed, skipping", { error: String(err) });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

export async function syncAllEmails(
  userId: string,
  category: string,
): Promise<void> {
  const tenant = corsair.withTenant(userId);

  const gmailQueryTerm = CATEGORY_TO_GMAIL_QUERY[category];
  const isSent = category === "SENT";

  let pageToken: string | undefined;

  do {
    const result = await withGmailRetry<{
      threads?: Array<{ id?: string }>;
      nextPageToken?: string | null;
    }>(`threads.list ${category}`, () =>
      tenant.gmail.api.threads.list({
        maxResults: 100,
        ...(isSent
          ? { labelIds: ["SENT"] }
          : gmailQueryTerm
            ? { q: `category:${gmailQueryTerm}` }
            : { labelIds: ["INBOX"] }),
        pageToken,
      }),
    );

    const detailed = await mapWithConcurrency(
      result.threads ?? [],
      10,
      (t: any) =>
        withGmailRetry(`threads.get ${t.id}`, () =>
          tenant.gmail.api.threads.get({
            id: t.id,
            format: "metadata",
          }),
        ),
    );

    const messageIds = detailed
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .flatMap((t: any) =>
        (t.messages ?? [])
          .map((m: any) => m.id)
          .filter(Boolean),
      );

    await processMessages(userId, messageIds);

    pageToken = result.nextPageToken ?? undefined;

    console.log(
      "SYNC",
      category,
      "processed",
      messageIds.length,
      "next",
      pageToken,
    );
  } while (pageToken);
}

export async function syncMailbox(userId: string) {
  for (const category of ALL_CATEGORIES) {
    // Isolate each category so an exhausted-retry failure in one (e.g. a
    // large PROMOTIONS folder) doesn't abort the remaining categories.
    try {
      await syncAllEmails(userId, category);
    } catch (err) {
      logger.error("[SYNC] syncAllEmails category failed, continuing", {
        userId, category, error: String(err),
      });
    }
  }
}