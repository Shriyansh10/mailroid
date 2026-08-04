/**
 * Dump what Google actually has stored for one event, as seen by one tenant.
 *
 * Exists to answer a narrower question than the probe does: the probe proved
 * the create → announce → getMany → filter mechanism works within a SINGLE
 * tenant. The first real guest-card test crosses tenants — the organiser
 * writes the property, a different user's calendar is queried for it — and
 * that path was never directly verified. This reads the raw event straight
 * from Google, from whichever tenant you point it at, so "does the organiser's
 * own copy have it" and "does the guest's own copy have it" can be checked as
 * two separate, unambiguous facts instead of inferred from a lookup result.
 *
 * Read-only. Never writes.
 */

import { corsair } from "@repo/corsair";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "calendar:inspect-event",
  description: "Print the raw extendedProperties/attendees/status Google has for one event, as seen by one tenant",
  usage: "<userId|email> <eventId>",

  async run(args) {
    const arg = args[0];
    const eventId = args[1];
    if (!arg) throw new UsageError("Missing <userId|email>.");
    if (!eventId) throw new UsageError("Missing <eventId>.");

    const userId = await resolveUserId(arg, "calendar");
    if (!userId) throw new UsageError(`No calendar tenant found for "${arg}".`);

    const tenant = corsair.withTenant(userId);

    out.section("Inspect event");
    out.keyValues([
      ["tenant id", userId],
      ["event id", eventId],
    ]);
    out.line();

    try {
      const event = (await tenant.googlecalendar.api.events.get({
        id: eventId,
      })) as unknown as {
        id?: string;
        status?: string;
        summary?: string;
        organizer?: { email?: string; self?: boolean };
        attendees?: Array<{ email?: string; responseStatus?: string; self?: boolean }>;
        extendedProperties?: { shared?: Record<string, string>; private?: Record<string, string> };
        recurringEventId?: string;
        iCalUID?: string;
      };

      out.keyValues([
        ["status", event.status],
        ["summary", event.summary],
        ["organizer", `${event.organizer?.email ?? "?"}${event.organizer?.self ? " (this tenant)" : ""}`],
        ["iCalUID", event.iCalUID],
      ]);

      out.line();
      out.line("attendees:");
      for (const a of event.attendees ?? []) {
        out.line(`  ${a.email ?? "?"}  ${a.responseStatus ?? "?"}${a.self ? "  (this tenant)" : ""}`);
      }
      if (!event.attendees?.length) out.line(out.dim("  (none)"));

      out.line();
      out.line("extendedProperties.shared:");
      const shared = event.extendedProperties?.shared;
      if (shared && Object.keys(shared).length > 0) {
        for (const [k, v] of Object.entries(shared)) out.success(`${k} = ${v}`);
      } else {
        out.error("(none — this tenant's copy of the event has no shared extended properties)");
      }
    } catch (err) {
      out.error(`Could not fetch the event: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
