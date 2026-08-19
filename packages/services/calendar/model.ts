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
  /**
   * The event's organizer — and therefore the Meet host, since Google derives
   * one from the other. Singular because Google Calendar's `organizer` is a
   * single object, not a list: an event has exactly one owner.
   */
  organizerEmail: z.string().optional(),
  /**
   * This user's own RSVP, when they are on the guest list.
   *
   * `needsAction` is Google's "invited, hasn't answered" — meaningfully
   * different from `undefined`, which means the question doesn't apply
   * (they're the organiser, or not invited at all). The RSVP control keys off
   * that difference, so the two must not be collapsed.
   */
  myResponseStatus: z
    .enum(["needsAction", "accepted", "declined", "tentative"])
    .optional(),
  meetLink: z.string().optional(),
  /**
   * Why there is (or isn't) a `meetLink`, which the link alone cannot say.
   *
   *   none    — no conference was asked for. The normal state.
   *   created — Google made one; `meetLink` is set.
   *   pending — Google accepted the request and is still working. `meetLink`
   *             is absent *for now*; a later read fills it in.
   *   failed  — a conference WAS requested and Google refused it.
   *
   * `pending` and `failed` both look identical to `none` if you only check
   * `meetLink`, and silently rendering "no Meet link" over a refusal is the
   * degradation CLAUDE.md forbids. Callers must be able to tell them apart.
   */
  meetStatus: z.enum(["none", "created", "pending", "failed"]).optional(),
  status: z.string().optional(),
  htmlLink: z.string().optional(),
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/** The four states of {@link calendarEventSchema.meetStatus}. */
export type MeetStatus = "none" | "created" | "pending" | "failed";

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
  /**
   * Ask Google to attach a Google Meet conference to this event.
   *
   * Only ever honoured on create. `updateEvent` deliberately never sends
   * `conferenceDataVersion`, which is what keeps an existing Meet link alive
   * across a reschedule — see the note above READ_ONLY_EVENT_FIELDS.
   */
  addMeet: z.boolean().optional(),
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
