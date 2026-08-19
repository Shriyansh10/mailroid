import { z } from "zod";

// ── Calendar event output ────────────────────────────────────────────

export const calendarEventOutputModel = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  /** The organizer / Meet host. Singular — Calendar events have one owner. */
  organizerEmail: z.string().optional(),
  /** This user's own RSVP; undefined when they aren't a guest on it. */
  myResponseStatus: z
    .enum(["needsAction", "accepted", "declined", "tentative"])
    .optional(),
  meetLink: z.string().optional(),
  /** See calendarEventSchema.meetStatus in @repo/services/calendar/model.ts. */
  meetStatus: z.enum(["none", "created", "pending", "failed"]).optional(),
  status: z.string().optional(),
  htmlLink: z.string().optional(),
});

export const calendarEventListOutputModel = z.array(calendarEventOutputModel);

// ── Create event input ──────────────────────────────────────────────

export const createEventInputModel = z.object({
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  // When the event is scheduled from a mail thread, these record the link so
  // rescheduling later moves the event instead of creating a second one.
  // Absent for calendar-only events (the /calendar page).
  threadId: z.string().optional(),
  entityId: z.string().optional(),
  /** Attach a Google Meet conference. Create-only — see the note on the model. */
  addMeet: z.boolean().optional(),
});

// ── Thread-linked meetings ──────────────────────────────────────────

export const threadMeetingOutputModel = z.object({
  eventId: z.string(),
  calendarId: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  attendees: z.array(z.string()),
  htmlLink: z.string().optional(),
  /** The Google Meet join URL, when the meeting has a conference attached. */
  meetLink: z.string().optional(),
  /** Where and what — the details Google mails to guests but not the organiser. */
  location: z.string().optional(),
  description: z.string().optional(),
  /** The organizer / Meet host. Singular — Calendar events have one owner. */
  organizerEmail: z.string().optional(),
  /** This user's own RSVP; undefined when they aren't a guest on it. */
  myResponseStatus: z
    .enum(["needsAction", "accepted", "declined", "tentative"])
    .optional(),
  /**
   * ORGANIZER: this user scheduled it and can move or cancel it.
   * GUEST: they were invited, and the card is read-only for them.
   */
  role: z.enum(["ORGANIZER", "GUEST"]),
});

export const threadMeetingsOutputModel = z.object({
  meetings: z.array(threadMeetingOutputModel),
  /**
   * Why the list is what it is — because `meetings: []` cannot distinguish
   * "there is no meeting" from "we couldn't tell", and rendering the second as
   * the first is exactly the silent degradation CLAUDE.md forbids.
   *
   *  - `none`          checked, including against Google: there is none.
   *  - `guest-linked`  found via the Message-ID join; user is an attendee.
   *  - `unindexed`     thread has no captured Message-IDs (synced before the
   *                    header was stored), so the join cannot be attempted.
   *  - `lookup-failed` the remote check errored. We do not know.
   */
  resolution: z.enum(["none", "guest-linked", "unindexed", "lookup-failed"]),
  /**
   * A meeting that was scheduled from this thread and has since been deleted
   * in Google, which the user hasn't dismissed yet. Drives the warning banner.
   * Persistent, not "detected on this request" — see getUnacknowledgedDeletion.
   */
  deletedLink: z
    .object({
      eventId: z.string(),
      calendarId: z.string(),
      title: z.string(),
      start: z.string(),
    })
    .nullable(),
});

/**
 * Returned by `create` so the caller can tell a total failure from a partial
 * one. `linked: false` means the event exists in Google but the thread doesn't
 * know about it — the caller must NOT offer a plain retry, which would create
 * a duplicate.
 */
export const createEventOutputModel = calendarEventOutputModel.extend({
  linked: z.boolean(),
});

// ── RSVP ────────────────────────────────────────────────────────────

export const respondToEventInputModel = z.object({
  id: z.string(),
  response: z.enum(["accepted", "declined", "tentative"]),
});

export const respondToEventOutputModel = z.object({
  id: z.string(),
  response: z.enum(["accepted", "declined", "tentative"]),
});

// ── Update event input ──────────────────────────────────────────────

export const updateEventInputModel = z.object({
  id: z.string(),
  title: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  allDay: z.boolean().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
});
