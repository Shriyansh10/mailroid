import { db, eq, and, inArray, asc } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { emails } from "@repo/database/models/emails";
import { getThread } from "@repo/services/gmail/index";
import { cleanEmailBody } from "./email-body-cleaner.ts";

// ── Thread transcript assembly ──────────────────────────────────────────
//
// Builds the text the summarizer actually reads. Before this existed the
// pipeline loaded ONE message body and called it a thread summary, which is
// how a 3-message thread whose first message said "Test" came back as
// "nothing substantive to summarize".
//
// Source selection is DB-first so Gmail is not on the hot path of every
// summarize, with a completeness test — see isDbComplete below for why the
// server cannot make that call from its own data alone.

/** Total transcript budget. summarizeEmail slices at 50k; stay under it. */
const MAX_TRANSCRIPT_CHARS = 45_000;

/** A client-supplied count above this is treated as garbage. */
const MAX_PLAUSIBLE_MESSAGE_COUNT = 500;

export interface ThreadMessageSource {
  id: string;
  from: string | null;
  date: string | null;
  body: string;
}

export interface ThreadSource {
  text: string;
  messageCount: number;
  /** Every participant's From header, for the protected-sender check. */
  senders: string[];
  source: "db" | "gmail";
}

/**
 * Normalizes the client's `messageCount` hint.
 *
 * It is an untrusted LOWER BOUND, never data: a value larger than what the
 * DB knows about forces the more expensive Gmail path, and anything else is
 * ignored. A lying client can therefore only make a request slower, never
 * make a summary wrong or short.
 */
export function normalizeMessageCountHint(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return undefined;
  if (raw < 1 || raw > MAX_PLAUSIBLE_MESSAGE_COUNT) return undefined;
  return raw;
}

/**
 * Can the DB alone serve this thread?
 *
 * The subtlety: `message_metadata` only holds rows for messages that have
 * been SYNCED. If the DB has 2 of a thread's 3 messages, its own COUNT says
 * 2, every row has a body, and it will happily summarize a transcript that
 * is silently missing a message. The DB can prove it is internally
 * consistent; it cannot prove it is complete.
 *
 * The client just rendered the real Gmail thread, so its count is the only
 * cheap external completeness signal available — used strictly as a lower
 * bound (see normalizeMessageCountHint).
 */
function isDbComplete(known: number, hydrated: number, hint?: number): boolean {
  if (known === 0 || hydrated !== known) return false;
  if (hint !== undefined && hint > known) return false;
  return true;
}

/**
 * Trims to the char budget while ALWAYS keeping the first message.
 *
 * Long threads answer a request made at the top ("please review the
 * proposal" ... 17 replies ... "approved"), so dropping the head loses the
 * thing every later message refers to. Newest messages are kept next,
 * backwards, because recency is the other end that matters.
 */
function applyBudget(messages: ThreadMessageSource[]): {
  kept: ThreadMessageSource[];
  omitted: number;
} {
  const size = (m: ThreadMessageSource) => m.body.length + 120; // + header line
  const total = messages.reduce((sum, m) => sum + size(m), 0);
  if (total <= MAX_TRANSCRIPT_CHARS || messages.length <= 2) {
    return { kept: messages, omitted: 0 };
  }

  const first = messages[0]!;
  let budget = MAX_TRANSCRIPT_CHARS - size(first);

  const tail: ThreadMessageSource[] = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    const m = messages[i]!;
    if (size(m) > budget) break;
    budget -= size(m);
    tail.unshift(m);
  }

  return {
    kept: [first, ...tail],
    omitted: messages.length - 1 - tail.length,
  };
}

/** Renders the cleaned messages into the transcript the model reads. */
function renderTranscript(messages: ThreadMessageSource[]): string {
  const { kept, omitted } = applyBudget(messages);
  const n = messages.length;

  const blocks: string[] = [];
  kept.forEach((m, i) => {
    // The gap is stated explicitly so the model doesn't read the message
    // after the first as a direct reply to it.
    if (omitted > 0 && i === 1) {
      blocks.push(`[… ${omitted} earlier message${omitted === 1 ? "" : "s"} omitted …]`);
    }
    const position = messages.indexOf(m) + 1;
    const header = [
      `Message ${position} of ${n}`,
      m.from ? `From: ${m.from}` : null,
      m.date ? `Date: ${m.date}` : null,
    ]
      .filter(Boolean)
      .join(" — ");
    blocks.push(`${header}\n\n${m.body}`);
  });

  return blocks.join("\n\n");
}

function toSource(
  messages: ThreadMessageSource[],
  source: "db" | "gmail",
): ThreadSource | null {
  // A one-word body ("Test") is short, not empty — it stays.
  const nonEmpty = messages.filter((m) => m.body.trim().length > 0);
  if (nonEmpty.length === 0) return null;

  return {
    text: renderTranscript(nonEmpty),
    messageCount: nonEmpty.length,
    senders: nonEmpty.map((m) => m.from ?? "").filter(Boolean),
    source,
  };
}

/** Reads the thread from `emails`, cleaning each body. */
async function fromDb(
  userId: string,
  entityIds: string[],
): Promise<ThreadMessageSource[]> {
  const rows = await db
    .select({
      id: emails.gmailMessageId,
      from: emails.from,
      date: emails.receivedAt,
      bodyText: emails.bodyText,
    })
    .from(emails)
    .where(and(eq(emails.userId, userId), inArray(emails.gmailMessageId, entityIds)))
    .orderBy(asc(emails.receivedAt));

  return rows.map((r) => ({
    id: r.id,
    from: r.from,
    date: r.date ? r.date.toISOString() : null,
    body: cleanEmailBody(r.bodyText).text,
  }));
}

/**
 * Writes back the bodies Gmail returned so the next summarize of this
 * thread is a pure DB read. Best-effort: a failed backfill must never fail
 * the summary it was riding along with.
 *
 * UPDATE only, deliberately never INSERT. A missing `emails` row means the
 * message was synced metadata-only (older mail outside the AI window), and
 * inserting one would enrol it in the embedding backlog — embedEmails picks
 * up every row where `embedding IS NULL` — quietly widening the AI scope
 * this deployment keeps narrow on purpose. The cost of not inserting is one
 * more Gmail fetch next time, which is the cheaper mistake.
 */
async function backfillBodies(
  userId: string,
  threadId: string,
  messages: { id: string; from: string | null; date: string | null; rawBody: string }[],
): Promise<void> {
  try {
    for (const m of messages) {
      if (!m.rawBody.trim()) continue;
      await db
        .update(emails)
        .set({ bodyText: m.rawBody, lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(emails.userId, userId), eq(emails.gmailMessageId, m.id)));
    }
  } catch (err) {
    console.warn("[thread-source] backfill failed", { threadId, error: err });
  }
}

/**
 * Assembles the transcript for a thread, or null when there is nothing
 * usable — in which case the caller falls back to the single-body path.
 */
export async function buildThreadSource(opts: {
  userId: string;
  threadId: string;
  messageCountHint?: number;
}): Promise<ThreadSource | null> {
  const { userId, threadId, messageCountHint } = opts;

  const known = await db
    .select({ entityId: messageMetadata.entityId })
    .from(messageMetadata)
    .where(and(eq(messageMetadata.userId, userId), eq(messageMetadata.threadId, threadId)));

  const knownIds = known.map((k) => k.entityId);

  if (knownIds.length > 0) {
    const dbMessages = await fromDb(userId, knownIds);
    const hydrated = dbMessages.filter((m) => m.body.trim().length > 0).length;

    if (isDbComplete(knownIds.length, hydrated, messageCountHint)) {
      console.info("[thread-source] db", { threadId, messages: knownIds.length });
      return toSource(dbMessages, "db");
    }
  }

  // DB is incomplete (or empty) — go to Gmail, which always has every body.
  try {
    const thread = await getThread(userId, threadId);
    console.info("[thread-source] gmail", {
      threadId,
      messages: thread.messages.length,
      known: knownIds.length,
      hint: messageCountHint,
    });
    const raw = thread.messages.map((m) => ({
      id: m.id,
      from: m.from ?? null,
      date: m.date ?? null,
      rawBody: m.body ?? "",
    }));

    await backfillBodies(userId, threadId, raw);

    return toSource(
      raw.map((m) => ({
        id: m.id,
        from: m.from,
        date: m.date,
        body: cleanEmailBody(m.rawBody).text,
      })),
      "gmail",
    );
  } catch (err) {
    console.warn("[thread-source] Gmail fetch failed; falling back to single body", {
      threadId,
      error: err,
    });
    return null;
  }
}
