import { db, and, eq, asc, isNotNull, ne } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { corsair } from "@repo/corsair";
import { normalizeMessageId, hashMessageIdForCalendar } from "./message-id.ts";

// Deliberately NOT imported from ./index.ts: that file imports
// clearThreadMeetingLookups from ../calendar/guest-links.ts, which imports
// THREAD_ROOT_MSG_ID_KEY from this file — importing back from index.ts here
// would close that into a circular import. getHeader is three lines; a local
// copy is cheaper than the cycle.
function getHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string {
  if (!headers) return "";
  const h = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

/**
 * The key used to stamp a calendar event with the thread it came from.
 *
 * 23 characters, inside Google's 44-char limit for an extended-property key.
 * Changing it orphans every event already stamped, so it is a constant rather
 * than something assembled at a call site.
 */
export const THREAD_ROOT_MSG_ID_KEY = "mailroidThreadRootMsgId";

/**
 * Ask Gmail directly for a thread's root Message-ID, bypassing our own sync.
 *
 * Exists for exactly one situation: a meeting is scheduled from a thread
 * seconds after a message was sent to it — either through Dobbie ("send this
 * and set up a call") or through compose (send + attach an invite in the same
 * submit, which ALWAYS races: `apps/web/components/inbox/compose-dialog.tsx`
 * fires `createEvent` the instant `sendEmail` resolves, with zero wait for the
 * webhook). `message_metadata` has no row for that message yet — sync is
 * asynchronous — so the local lookup below comes up empty even though the
 * thread very much has a message.
 *
 * `threads.get(format:"metadata")` returns messages in the thread in
 * chronological order, so the first one IS the root; no extra sorting needed.
 * Not persisted back to `message_metadata` — the ordinary webhook sync will
 * write that row itself within seconds, and inserting a partial row here
 * risks fighting that write over columns this function never learns (category,
 * flags, snippet, …). This is a fallback for one read, not a second sync path.
 */
async function fetchThreadRootMessageIdLive(
  userId: string,
  threadId: string,
): Promise<string | null> {
  try {
    const tenant = corsair.withTenant(userId);
    const thread = (await tenant.gmail.api.threads.get({
      id: threadId,
      format: "metadata",
    })) as unknown as {
      messages?: Array<{ payload?: { headers?: Array<{ name?: string; value?: string }> } }>;
    };

    const first = thread.messages?.[0];
    if (!first) return null;

    return normalizeMessageId(getHeader(first.payload?.headers, "Message-ID"));
  } catch (error) {
    // A live Gmail call failing must not be worse than the sync gap it's
    // covering for — fall through to "no root", same as the ordinary
    // not-synced-yet case, rather than throwing out of a scheduling call.
    console.error("[thread-headers] live thread fetch failed", {
      userId, threadId, error: String(error),
    });
    return null;
  }
}

/**
 * The Message-ID of the OLDEST message we hold in a thread.
 *
 * The root is chosen deliberately over the newest. A guest's copy of a
 * conversation is a different Gmail thread with different ids, but the two
 * overlap in the messages they actually contain — and the message most likely
 * to be in both is the one the conversation started with. The newest message
 * might have arrived after the guest was added, or not have reached them at
 * all.
 *
 * It is not a guarantee: someone added midway through a long thread genuinely
 * may not hold the root, and for them this returns a value that matches
 * nothing. That is a known limit of the mechanism, surfaced as "we can't tell"
 * on the thread page rather than as a confident "no meeting".
 *
 * Reads local metadata first — no Gmail call, cheap enough to sit on the
 * scheduling path — and falls back to asking Gmail live
 * (`fetchThreadRootMessageIdLive`) only when that comes up empty. The fallback
 * is what closes the send-then-immediately-schedule race, in both the
 * assistant and compose flows, without waiting on sync.
 */
export async function getThreadRootMessageId(
  userId: string,
  threadId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ rfc822MessageId: messageMetadata.rfc822MessageId })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        eq(messageMetadata.threadId, threadId),
        isNotNull(messageMetadata.rfc822MessageId),
        // '' means "checked, nothing to store" — a backfill bookkeeping value,
        // not an id. See the column comment.
        ne(messageMetadata.rfc822MessageId, ""),
      ),
    )
    .orderBy(asc(messageMetadata.receivedAt))
    .limit(1);

  if (row?.rfc822MessageId) return row.rfc822MessageId;

  return fetchThreadRootMessageIdLive(userId, threadId);
}

/**
 * The shared extended properties to stamp on a meeting scheduled from a thread.
 *
 * Returns an empty object when the thread has no captured Message-ID — mail
 * synced before the header was captured, chiefly. The caller must still create
 * the event in that case: refusing to schedule because of a missing sync
 * artefact would be a far worse failure than a guest not seeing a card.
 *
 * The stamped value is a HASH of the root Message-ID, not the raw header —
 * `pnpm admin calendar:probe-shared-props` confirmed Google's
 * `sharedExtendedProperty` filter fails to match a real Gmail Message-ID once
 * it contains the `+`/`=` characters most of them do, even though the
 * property itself writes and reads back fine. See `hashMessageIdForCalendar`.
 */
export async function buildThreadSharedProperties(
  userId: string,
  threadId: string,
): Promise<Record<string, string>> {
  const rootMessageId = await getThreadRootMessageId(userId, threadId);

  if (!rootMessageId) {
    // Loud but not fatal, and greppable: at volume this is the signal that the
    // backfill hasn't run or that a sync path is dropping the header.
    console.error("[calendar-service:no-thread-root-message-id]", { userId, threadId });
    return {};
  }

  return {
    [THREAD_ROOT_MSG_ID_KEY]: hashMessageIdForCalendar(rootMessageId),
    // Diagnostic only, never queried: makes "why can't X see this meeting?"
    // answerable from the event itself.
    mailroidOrganizerThreadId: threadId,
  };
}
