/**
 * Call findGuestThreadMeetings directly, bypassing the browser/tRPC/React
 * Query entirely.
 *
 * Exists to answer one question unambiguously: when the guest's thread page
 * reports resolution:"none", is that a fresh answer from Google, or a stale
 * one served from the browser's HTTP cache / React Query's staleTime before
 * ever reaching the server? This calls the exact same function the tRPC route
 * calls, from a clean process, so there is no cache layer left to doubt.
 *
 * Read-only: findGuestThreadMeetings only ever writes a negative-cache marker
 * or a thread_calendar_events link row, both idempotent and both exactly what
 * a real page load would do.
 */

import { findGuestThreadMeetings } from "@repo/services/calendar/guest-links";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "calendar:test-guest-lookup",
  description: "Call findGuestThreadMeetings directly for one user+thread, bypassing all caches",
  usage: "<userId|email> <threadId>",
  destructive: true, // may write a negative-cache marker or a link row

  async run(args) {
    const arg = args[0];
    const threadId = args[1];
    if (!arg) throw new UsageError("Missing <userId|email>.");
    if (!threadId) throw new UsageError("Missing <threadId>.");

    const userId = await resolveUserId(arg, "calendar");
    if (!userId) throw new UsageError(`No calendar tenant found for "${arg}".`);

    out.section("findGuestThreadMeetings");
    out.keyValues([
      ["tenant id", userId],
      ["thread id", threadId],
    ]);
    out.line();

    const start = Date.now();
    const result = await findGuestThreadMeetings(userId, threadId);
    const durationMs = Date.now() - start;

    out.keyValues([
      ["resolution", result.resolution],
      ["eventIds", result.eventIds.length ? result.eventIds.join(", ") : "(none)"],
      ["durationMs", durationMs],
    ]);

    out.line();
    if (result.eventIds.length > 0) {
      out.success("Found. Reload the thread page — getActiveThreadMeetings should now show it (link was just persisted).");
    } else if (result.resolution === "none") {
      out.warn("Google's sharedExtendedProperty filter returned nothing for this thread's root Message-ID, right now, live.");
    } else {
      out.warn(`resolution=${result.resolution} — see the reasoning in guest-links.ts for what this means.`);
    }
  },
});
