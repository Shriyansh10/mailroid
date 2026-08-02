/**
 * One-off repair: renew every Gmail watch, using the stored OAuth token.
 *
 * Run from anywhere with DB access and the Corsair env — registering a watch
 * is an OUTBOUND call to Google, so it does not need your server to be
 * publicly reachable. (Receiving the resulting pushes does; that is a separate
 * problem, see the note at the bottom.)
 *
 * No OAuth flow, no reconnect: startGmailWatch pulls the access token via
 * Corsair (refreshing it if stale) and POSTs to gmail/v1/users/me/watch.
 *
 *   cd packages/services && npx tsx scratch/renew_gmail_watches.ts
 *
 * Safe to re-run: Gmail treats a repeat watch call as an extension.
 */
import { db } from "../../database/index.ts";
import { gmailTenantMappings } from "../../database/models/gmail-tenant-mappings.ts";
import { startGmailWatch } from "../gmail/watch.ts";

async function main() {
  const mappings = await db
    .select({
      tenantId: gmailTenantMappings.tenantId,
      emailAddress: gmailTenantMappings.emailAddress,
      watchExpiration: gmailTenantMappings.watchExpiration,
    })
    .from(gmailTenantMappings);

  if (mappings.length === 0) {
    console.log("No Gmail tenant mappings found — nothing to renew.");
    process.exit(0);
  }

  const now = Date.now();
  console.log(`Found ${mappings.length} mapping(s):\n`);
  for (const m of mappings) {
    const exp = m.watchExpiration?.getTime() ?? 0;
    const state = !exp ? "NEVER SET" : exp < now ? "EXPIRED" : "alive";
    console.log(`  ${m.emailAddress.padEnd(34)} ${state.padEnd(10)} ${m.watchExpiration?.toISOString() ?? "-"}`);
  }
  console.log("");

  let renewed = 0;
  const failures: Array<{ email: string; error: string }> = [];

  for (const m of mappings) {
    try {
      await startGmailWatch(m.tenantId);
      renewed++;
      console.log(`✓ renewed  ${m.emailAddress}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ email: m.emailAddress, error });
      console.error(`✗ FAILED   ${m.emailAddress}: ${error}`);
    }
  }

  // Read back so the new expirations are visible rather than assumed.
  const after = await db
    .select({
      emailAddress: gmailTenantMappings.emailAddress,
      watchExpiration: gmailTenantMappings.watchExpiration,
    })
    .from(gmailTenantMappings);

  console.log(`\n${renewed}/${mappings.length} renewed. New expirations:`);
  for (const m of after) {
    console.log(`  ${m.emailAddress.padEnd(34)} ${m.watchExpiration?.toISOString() ?? "-"}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failed:`, JSON.stringify(failures, null, 2));
    process.exit(1);
  }

  console.log(
    "\nNote: a live watch only means Google will PUSH. Those pushes go to the\n" +
      "Pub/Sub subscription's endpoint — they will not reach a local machine.\n" +
      "Mail lands in Mailroid only when apps/api is publicly reachable at\n" +
      "/api/webhook.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
