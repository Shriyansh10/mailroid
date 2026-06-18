import { pgTable, text, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";

export const calendarEvents = pgTable("calendar_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  eventId: text("event_id").unique().notNull(),
  title: text("title").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  description: text("description"),
  location: text("location"),
  organizerEmail: text("organizer_email"),
  attendees: jsonb("attendees"),
  status: text("status"),
  htmlLink: text("html_link"),
  updatedAtGoogle: timestamp("updated_at_google", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
