/**
 * One-time cleanup: stop orphaned Google Calendar watch channels.
 *
 * Background: before the "stop-old-channel-on-register" fix, every calendar
 * watch re-registration minted a fresh channel and left the old one alive.
 * Google keeps pushing to every live channel until it expires (~7 days), and
 * because only the newest channel is stored in calendar_tenant_mappings, the
 * old ones become orphans the webhook can't map to a tenant. This script stops
 * them now so they go quiet before their natural expiry.
 *
 * Orphans aren't in the DB (only the newest channel is), so the known orphan
 * (channelId, resourceId) pairs are read from the webhook logs and passed in.
 * Stopping requires a calendar access token for the tenant that owns the
 * channel's resource — so run it per owning tenant.
 *
 * Usage (from the machine/container with DATABASE_URL + CORSAIR_KEK in env):
 *
 *   # explicit pairs:
 *   pnpm --filter api exec dotenv -- tsx src/scripts/stop-calendar-channels.ts \
 *     <userId|email> <channelId>:<resourceId> [<channelId>:<resourceId> ...]
 *
 *   # built-in known-orphan list for the given tenant (pairs whose resourceId
 *   # matches that tenant's calendar):
 *   pnpm --filter api exec dotenv -- tsx src/scripts/stop-calendar-channels.ts <userId|email>
 */
import { corsair } from "@repo/corsair";
import { db, sql } from "@repo/database";
import { stopCalendarChannel } from "@repo/services/calendar/watch";

// Known orphan channels observed pushing to the webhook (from server logs).
// Each will only be stoppable by the tenant that owns its resourceId.
const KNOWN_ORPHANS: Array<{ channelId: string; resourceId: string }> = [
  { channelId: "1d6da109-a8d7-4a0e-8f70-524a26891c41", resourceId: "Eyby2GWzL3oahKVlV87TNcq3nVA" },
  { channelId: "653429a7-1735-42e1-b7b4-60c897afd583", resourceId: "Eyby2GWzL3oahKVlV87TNcq3nVA" },
  { channelId: "3cbe78ac-53c7-44a7-bee5-6451a5aad42b", resourceId: "zr841PQRuZVvzoskn-bNP8-hebY" },
];

async function resolveUserId(arg: string): Promise<string | null> {
  if (arg.includes("@")) {
    const rows = await db.execute(
      sql`SELECT tenant_id FROM calendar_tenant_mappings WHERE email_address = ${arg} LIMIT 1`,
    );
    const row = (rows as unknown as { rows?: Array<{ tenant_id: string }> }).rows?.[0]
      ?? (Array.isArray(rows) ? (rows[0] as { tenant_id?: string }) : undefined);
    return row?.tenant_id ?? null;
  }
  return arg;
}

function parsePairs(args: string[]): Array<{ channelId: string; resourceId: string }> {
  return args.map((a) => {
    const [channelId, resourceId] = a.split(":");
    if (!channelId || !resourceId) {
      throw new Error(`Invalid pair "${a}" — expected <channelId>:<resourceId>`);
    }
    return { channelId, resourceId };
  });
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: stop-calendar-channels.ts <userId|email> [<channelId>:<resourceId> ...]");
    process.exit(1);
  }

  const userId = await resolveUserId(arg);
  if (!userId) {
    console.error(`No calendar tenant found for "${arg}".`);
    process.exit(1);
  }

  const pairs = process.argv.length > 3 ? parsePairs(process.argv.slice(3)) : KNOWN_ORPHANS;
  console.log(`Stopping ${pairs.length} channel(s) as tenant ${userId}...`);

  const tenant = corsair.withTenant(userId);
  // Nudge Corsair to refresh the token if it's expired.
  try {
    await tenant.googlecalendar.api.events.getMany({ maxResults: 1 });
  } catch {
    /* best-effort */
  }
  const accessToken = await tenant.googlecalendar.keys.get_access_token();
  if (!accessToken) {
    console.error(`No calendar access token for tenant ${userId}.`);
    process.exit(1);
  }

  for (const { channelId, resourceId } of pairs) {
    await stopCalendarChannel(accessToken, channelId, resourceId);
  }

  console.log("Done. Channels that returned 204/404 are no longer delivering.");
  process.exit(0);
}

main().catch((err) => {
  console.error("stop-calendar-channels failed:", err);
  process.exit(1);
});
