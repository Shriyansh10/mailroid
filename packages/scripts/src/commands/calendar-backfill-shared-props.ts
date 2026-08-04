/**
 * Stamp existing thread meetings with their thread's root Message-ID.
 *
 * Meetings scheduled before this feature carry no `extendedProperties.shared`,
 * so their guests cannot find them — the join key simply isn't on the event.
 * This adds it retroactively.
 *
 * ⚠ THE THING THIS COMMAND MUST NOT DO IS EMAIL ANYONE.
 *
 * The create path deliberately re-sends events with `sendUpdates: "all"` so
 * guests actually get invited; reusing that here would fire an "invitation
 * updated" mail at every attendee of every historical meeting, for a change
 * none of them can even see. The silent write lives in the calendar service as
 * `addEventSharedProperties` (`sendUpdates: "none"`, whole-event echo because
 * the plugin offers no `events.patch` and `update` is a PUT).
 *
 * Run `gmail:backfill-message-ids` first — without stored Message-IDs there is
 * nothing to stamp, and this will report every meeting as unresolvable.
 *
 * Always dry-run first.
 */

import { db, and, eq } from "@repo/database";
import { threadCalendarEvents } from "@repo/database/models/thread-calendar-events";
import { buildThreadSharedProperties } from "@repo/services/gmail/thread-headers";
import { addEventSharedProperties } from "@repo/services/calendar/index";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "calendar:backfill-shared-props",
  description: "Add the thread Message-ID marker to meetings scheduled before guest linking",
  usage: "<userId|email> [--dry-run]",
  destructive: true,

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "calendar");
    if (!userId) throw new UsageError(`No calendar tenant found for "${arg}".`);

    const dryRun = args.includes("--dry-run");

    const links = await db
      .select({
        eventId: threadCalendarEvents.eventId,
        threadId: threadCalendarEvents.threadId,
      })
      .from(threadCalendarEvents)
      .where(
        and(
          eq(threadCalendarEvents.userId, userId),
          eq(threadCalendarEvents.status, "ACTIVE"),
          // Only meetings this user owns: patching an event you were merely
          // invited to is not yours to do, and Google would reject it anyway.
          eq(threadCalendarEvents.role, "ORGANIZER"),
        ),
      );

    out.section("Backfill event shared properties");
    out.keyValues([
      ["tenant id", userId],
      ["active meetings", links.length],
      ["mode", dryRun ? "DRY RUN — nothing written, nobody emailed" : "PATCHING (sendUpdates: none)"],
    ]);

    if (links.length === 0) {
      out.line();
      out.success("Nothing to do.");
      return;
    }

    let stamped = 0;
    let unresolvable = 0;
    let failed = 0;

    out.line();

    for (const link of links) {
      const shared = await buildThreadSharedProperties(userId, link.threadId);

      if (Object.keys(shared).length === 0) {
        unresolvable++;
        out.warn(`${link.eventId}: thread ${link.threadId} has no stored Message-ID`);
        continue;
      }

      if (dryRun) {
        out.line(out.dim(`  would stamp ${link.eventId} ← ${Object.values(shared)[0]}`));
        stamped++;
        continue;
      }

      try {
        await addEventSharedProperties(userId, link.eventId, shared);
        stamped++;
      } catch (error) {
        failed++;
        out.warn(`${link.eventId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    out.section("Result");
    out.counts([
      [dryRun ? "would stamp" : "stamped", stamped],
      ["no Message-ID for the thread", unresolvable],
      ["failed", failed],
    ]);

    if (unresolvable > 0) {
      out.line();
      out.warn("Run gmail:backfill-message-ids first, then re-run this.");
    }
    if (dryRun && stamped > 0) {
      out.line();
      out.line(out.dim("Re-run without --dry-run to apply. No attendee is emailed either way."));
    }
  },
});
