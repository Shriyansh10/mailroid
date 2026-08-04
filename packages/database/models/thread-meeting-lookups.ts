import { pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/**
 * Negative cache for the guest-side meeting lookup.
 *
 * A row means: *we asked Google whether any event carries one of this thread's
 * Message-IDs, and the answer was no.* Positive results are not stored here —
 * they become a real `thread_calendar_events` link, which is what the next
 * request finds first.
 *
 * This exists because the guest lookup is lazy: `calendar_events` is only a
 * −7d/+30d sync cache, so a miss there has to fall through to Google rather
 * than be reported as "no meeting". Without a negative cache, every page load
 * of every thread that genuinely has no meeting — the overwhelming majority —
 * would make that call. That is the failure mode that makes a lazy fallback
 * *worse* than eagerly syncing a wide window, and it is entirely avoidable.
 *
 * IT IS A CACHE, NEVER AN ANSWER. It suppresses a remote call; it does not
 * make the thread page say anything different. A stale row can only delay a
 * card, never invent or hide one.
 *
 * Invalidation is event-driven, with the TTL as a backstop rather than the
 * mechanism (a pure TTL would leave a guest reading "no meeting" for minutes
 * after they were actually invited):
 *
 *   - their own calendar webhook fires on being invited → syncCalendarEvents
 *     writes an event carrying a threadMessageId → clears that user's markers.
 *     This is the signal that matters; it makes the card appear in seconds.
 *   - new mail arrives on the thread → clears that thread's marker, since the
 *     set of Message-IDs to match against may have grown.
 *   - `expiresAt` covers only what neither signal catches.
 */
export const threadMeetingLookups = pgTable(
  "thread_meeting_lookups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    /** Kept for debugging: how old is this answer, independent of the TTL. */
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Stored rather than recomputed as `checkedAt + TTL` at each read site, so
     * the expiry rule lives in one place, changing the TTL doesn't require
     * finding every caller, and rows written under an old TTL keep the
     * deadline they were actually written with.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("uq_tml_user_thread").on(t.userId, t.threadId)],
);
