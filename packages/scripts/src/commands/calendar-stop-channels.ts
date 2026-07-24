/**
 * Stop orphaned Google Calendar watch channels.
 *
 * Migrated from apps/api/src/scripts/stop-calendar-channels.ts.
 *
 * Background: before the "stop-old-channel-on-register" fix, every calendar
 * watch re-registration minted a fresh channel and left the old one alive.
 * Google keeps pushing to every live channel until it expires (~7 days), and
 * because only the newest channel is stored in calendar_tenant_mappings, the
 * old ones become orphans the webhook can't map to a tenant. This stops them
 * now so they go quiet before their natural expiry.
 *
 * Orphans aren't in the DB (only the newest channel is), so the known orphan
 * pairs were read from the webhook logs and are listed below. Stopping requires
 * a calendar access token for the tenant that owns the channel's resource — so
 * run it per owning tenant.
 */

import { corsair } from "@repo/corsair";
import { stopCalendarChannel } from "@repo/services/calendar/watch";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

/**
 * Known orphan channels observed pushing to the webhook (from server logs).
 * Each is only stoppable by the tenant that owns its resourceId.
 */
const KNOWN_ORPHANS: Array<{ channelId: string; resourceId: string }> = [
  { channelId: "1d6da109-a8d7-4a0e-8f70-524a26891c41", resourceId: "Eyby2GWzL3oahKVlV87TNcq3nVA" },
  { channelId: "653429a7-1735-42e1-b7b4-60c897afd583", resourceId: "Eyby2GWzL3oahKVlV87TNcq3nVA" },
  { channelId: "3cbe78ac-53c7-44a7-bee5-6451a5aad42b", resourceId: "zr841PQRuZVvzoskn-bNP8-hebY" },
];

function parsePairs(args: string[]): Array<{ channelId: string; resourceId: string }> {
  return args.map((a) => {
    const [channelId, resourceId] = a.split(":");
    if (!channelId || !resourceId) {
      throw new UsageError(`Invalid pair "${a}" — expected <channelId>:<resourceId>`);
    }
    return { channelId, resourceId };
  });
}

export default defineCommand({
  name: "calendar:stop-channels",
  description: "Stop orphaned Google Calendar watch channels",
  usage: "<userId|email> [<channelId>:<resourceId> ...]",
  destructive: true,

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "calendar");
    if (!userId) throw new UsageError(`No calendar tenant found for "${arg}".`);

    const explicit = args.slice(1);
    const pairs = explicit.length > 0 ? parsePairs(explicit) : KNOWN_ORPHANS;

    out.section("Stop watch channels");
    out.keyValues([
      ["tenant id", userId],
      ["channels", pairs.length],
      ["source", explicit.length > 0 ? "arguments" : "built-in known-orphan list"],
    ]);

    const tenant = corsair.withTenant(userId);

    // Nudge Corsair into refreshing the token if it has expired — the stop call
    // below needs a live access token and won't trigger a refresh itself.
    try {
      await tenant.googlecalendar.api.events.getMany({ maxResults: 1 });
    } catch {
      /* best-effort */
    }

    const accessToken = await tenant.googlecalendar.keys.get_access_token();
    if (!accessToken) {
      throw new UsageError(`No calendar access token for tenant ${userId}.`);
    }

    out.line();
    for (const { channelId, resourceId } of pairs) {
      await stopCalendarChannel(accessToken, channelId, resourceId);
      out.success(`stopped ${channelId}`);
    }

    out.line();
    out.line(out.dim("Channels that returned 204/404 are no longer delivering."));
  },
});
