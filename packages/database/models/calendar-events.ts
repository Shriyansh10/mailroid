import { pgTable, text, timestamp, uuid, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    // NOT globally unique. A Google event id identifies the *meeting*, and the
    // organiser and every attendee hold that same id in their own calendar —
    // so one id legitimately maps to one row per user. It used to carry a bare
    // .unique(), which meant whichever user synced second overwrote the first
    // user's row (flipping its user_id) rather than inserting their own.
    eventId: text("event_id").notNull(),
    title: text("title").notNull(),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }).notNull(),
    description: text("description"),
    location: text("location"),
    organizerEmail: text("organizer_email"),
    attendees: jsonb("attendees"),
    status: text("status"),
    htmlLink: text("html_link"),
    // extendedProperties.shared.mailroidThreadRootMsgId, when present: the
    // RFC822 Message-ID of the root message of the thread this meeting was
    // scheduled from.
    //
    // Shared extended properties are visible on EVERY attendee's copy of an
    // event, so a guest's own synced row carries the organiser's thread marker
    // — which is what lets the guest's thread page find a meeting that was
    // never linked under their (different) Gmail thread id.
    threadMessageId: text("thread_message_id"),
    updatedAtGoogle: timestamp("updated_at_google", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("calendar_events_user_event_idx").on(t.userId, t.eventId),
    // The guest-side lookup: "do I hold an event carrying any of this thread's
    // Message-IDs?"
    index("idx_calendar_events_user_thread_msg").on(t.userId, t.threadMessageId),
  ],
);
