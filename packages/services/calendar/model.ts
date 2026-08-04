import { z } from "zod";

// ── Normalized calendar event (what the frontend sees) ───────────────

export const calendarEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  meetLink: z.string().optional(),
  status: z.string().optional(),
  htmlLink: z.string().optional(),
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;

// ── Get events input ─────────────────────────────────────────────────

export const getEventsInputSchema = z.object({
  timeMin: z.string(),
  timeMax: z.string(),
});

export type GetEventsInput = z.infer<typeof getEventsInputSchema>;

// ── Create event input ──────────────────────────────────────────────

export const createEventInputSchema = z.object({
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  /**
   * Written to `extendedProperties.shared`, which Google copies onto EVERY
   * attendee's version of the event — unlike `.private`, which stays on the
   * organiser's. That is what lets a guest identify a meeting scheduled from a
   * thread whose Gmail id they do not share.
   *
   * Google's limits: key ≤ 44 chars, value ≤ 1024, and a filtered lookup
   * requires an exact `key=value` match.
   */
  sharedProperties: z.record(z.string(), z.string()).optional(),
});

export type CreateEventInput = z.infer<typeof createEventInputSchema>;

// ── Update event input ──────────────────────────────────────────────

export const updateEventInputSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  allDay: z.boolean().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
});

export type UpdateEventInput = z.infer<typeof updateEventInputSchema>;

// ── Delete event input ──────────────────────────────────────────────

export const deleteEventInputSchema = z.object({
  id: z.string(),
});

export type DeleteEventInput = z.infer<typeof deleteEventInputSchema>;
