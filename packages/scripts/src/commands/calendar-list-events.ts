/**
 * List a tenant's own events in a window around now, with their event ids.
 *
 * Exists so a specific event's id can be found without hand-decoding Google
 * Calendar's `eid=` URL parameter (base64 of "<eventId> <calendarId>",
 * sometimes URL-safe-encoded, easy to get wrong by hand). Read-only.
 */

import { corsair } from "@repo/corsair";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "calendar:list-events",
  description: "List a tenant's own events around now, with event ids — to find one for calendar:inspect-event",
  usage: "<userId|email> [--days N] [--query text]",

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "calendar");
    if (!userId) throw new UsageError(`No calendar tenant found for "${arg}".`);

    const daysIdx = args.indexOf("--days");
    const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 3;
    if (Number.isNaN(days)) throw new UsageError("--days needs a number.");

    const queryIdx = args.indexOf("--query");
    const query = queryIdx >= 0 ? args[queryIdx + 1] : undefined;

    const tenant = corsair.withTenant(userId);
    const timeMin = new Date(Date.now() - days * 86_400_000).toISOString();
    const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();

    const response = (await tenant.googlecalendar.api.events.getMany({
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
      ...(query ? { q: query } : {}),
    })) as unknown as {
      items?: Array<{
        id?: string;
        summary?: string;
        status?: string;
        start?: { dateTime?: string; date?: string };
        extendedProperties?: { shared?: Record<string, string> };
      }>;
    };

    const items = response.items ?? [];

    out.section("Events");
    out.keyValues([
      ["tenant id", userId],
      ["window", `±${days}d`],
      ["query", query ?? "(none)"],
      ["found", items.length],
    ]);
    out.line();

    if (items.length === 0) {
      out.warn("No events in this window. Widen --days or check --query.");
      return;
    }

    for (const e of items) {
      const when = e.start?.dateTime ?? e.start?.date ?? "?";
      const hasShared = !!e.extendedProperties?.shared && Object.keys(e.extendedProperties.shared).length > 0;
      out.line(`${when}  ${(e.status ?? "?").padEnd(10)} ${hasShared ? "🔗" : "  "} ${e.summary ?? "(no title)"}`);
      out.line(out.dim(`           id: ${e.id}`));
    }

    out.line();
    out.line(out.dim("🔗 = carries extendedProperties.shared. Copy an id and run:"));
    out.line(out.dim(`   pnpm admin calendar:inspect-event ${arg} <id>`));
  },
});
