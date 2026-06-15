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
