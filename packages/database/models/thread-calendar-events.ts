import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

// ── Enums ─────────────────────────────────────────────────────────────

/**
 * Cancelling through Mailroid and finding the event gone in Google are
 * different facts, so they are different states. The first is an action we
 * took and can explain; the second is drift we detected, and it is what
 * drives the "this meeting no longer exists" banner in the compose surfaces.
 * A single nullable `cancelled_at` would have collapsed the two.
 */
export const threadEventStatusEnum = pgEnum("thread_event_status", [
  "ACTIVE",
  "CANCELLED",
  "DELETED_EXTERNALLY",
]);

// ── Thread → calendar event links ─────────────────────────────────────

/**
 * The relationship a Gmail thread has to the calendar events scheduled from
 * it. Deliberately holds *only* the relationship: title, times and attendees
 * are always read back from Google (via `calendar_events`, or a live
 * `events.get` when the webhook hasn't synced yet), so an event edited on the
 * /calendar page or in Google Calendar directly is never stale here.
 *
 * Rows are immutable history. A row is created once and only ever transitions
 * ACTIVE → CANCELLED | DELETED_EXTERNALLY; it is never reused for a different
 * event, and its `event_id` is never rewritten. A new meeting is always a new
 * row. That is what makes "what happened to this thread's meetings" answerable
 * by reading the table.
 */
export const threadCalendarEvents = pgTable(
  "thread_calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    /**
     * Google event ids are only unique *within a calendar*, so the pair is the
     * real identity. Everything writes "primary" today, but the Corsair
     * endpoints all accept a calendarId, so multi-calendar is a plumbing
     * change from here rather than a migration.
     */
    calendarId: text("calendar_id").notNull().default("primary"),
    eventId: text("event_id").notNull(),
    /** Message the invite was sent from, when known. Provenance only. */
    entityId: text("entity_id"),
    status: threadEventStatusEnum("status").notNull().default("ACTIVE"),
    /** When the row left ACTIVE. Null while active. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /**
     * When the user dismissed the "this meeting no longer exists" banner.
     * The banner is driven by this column rather than by "did this request
     * just detect the deletion", because the latter is true exactly once —
     * the next refetch would find the row already stamped and make the
     * warning disappear on its own.
     */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_tce_user_thread_status").on(t.userId, t.threadId, t.status),
    uniqueIndex("uq_tce_user_calendar_event").on(
      t.userId,
      t.calendarId,
      t.eventId,
    ),
  ],
);
