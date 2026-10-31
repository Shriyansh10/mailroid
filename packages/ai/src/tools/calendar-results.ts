/**
 * Calendar data as the model may see it.
 *
 * Attendees are NAMES, never addresses. The model cannot use an address
 * anyway: scheduling names people by handle (resolveRecipient), and the server
 * turns handles into addresses at the moment of writing the invite. An
 * attendee with no known name becomes "[EMAIL]"; the account itself becomes
 * "You".
 *
 * Titles, descriptions and locations are free text written by whoever sent
 * the invite. Dial-in numbers and addresses are common in them, so they go
 * through the same masking as mailbox text. Ids, times and statuses pass
 * through untouched.
 */
import { maskForModel } from "./model-masking.ts";

/** Lower-cased address → a name for that person, from whichever source had one. */
export type AttendeeNames = Record<string, string | undefined>;

export function attendeesForModel(
  addresses: string[] | undefined,
  names: AttendeeNames,
  selfEmail?: string,
): string[] {
  const self = selfEmail?.trim().toLowerCase();
  return (addresses ?? []).map((address) => {
    const key = address.trim().toLowerCase();
    if (self && key === self) return "You";
    const name = names[key]?.trim();
    // A "name" that is itself an address is no name at all.
    const masked = name ? maskForModel(name) : "";
    return masked && !masked.includes("[EMAIL]") ? masked : "[EMAIL]";
  });
}

export interface EventInput {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  description?: string;
  location?: string;
  attendees?: string[];
  status?: string;
}

export function eventForModel(ev: EventInput, names: AttendeeNames, selfEmail?: string) {
  return {
    id: ev.id,
    title: maskForModel(ev.title),
    start: ev.start,
    end: ev.end,
    allDay: ev.allDay,
    description: ev.description ? maskForModel(ev.description) : undefined,
    location: ev.location ? maskForModel(ev.location) : undefined,
    attendees: attendeesForModel(ev.attendees, names, selfEmail),
    status: ev.status,
  };
}

/** Every address across these attendee lists, for one name lookup. */
export function allAttendeeAddresses(lists: Array<string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((l) => l ?? []).map((a) => a.trim().toLowerCase()))];
}

/** Google's names first, then names already known from mail; Google wins. */
export function mergeAttendeeNames(...sources: Array<Record<string, string> | undefined>): AttendeeNames {
  const out: AttendeeNames = {};
  for (const source of sources.reverse()) Object.assign(out, source ?? {});
  return out;
}
