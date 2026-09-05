/**
 * (Re-)register a mailbox's Gmail watch (P-2, docs/gmail-rate-limit-boundary.md
 * §13).
 *
 * WHY THIS EXISTS. bootstrapGmailWatches is now gated to production only
 * (P-11) — it no longer renews anything on a local restart, which used to
 * paper over the fact that nothing else renews local watches either
 * (gmailWatchCron needs a running local Inngest dev server, which most local
 * setups don't have). A local watch that lapses therefore just stays lapsed
 * — Gmail stops pushing, silently, until someone reconnects or renews by
 * hand. This is that hand.
 *
 * Calls the exact same startGmailWatch used by the OAuth callback and the
 * production cron — not a special "local-only" path — so it also stamps
 * watchTopic/watchOwnerEnv (P-2) and preserves the existing lastHistoryId
 * cursor rather than moving it (see the invariant comment in watch.ts).
 */

import { db, eq } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { startGmailWatch } from "@repo/services/gmail/watch.js";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "gmail:renew-watch",
  description: "(Re-)register a mailbox's Gmail watch — costs 100 quota units",
  usage: "<userId|email>",
  destructive: true,

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "gmail");
    if (!userId) throw new UsageError(`No Gmail tenant found for "${arg}".`);

    const before = await db
      .select({
        emailAddress: gmailTenantMappings.emailAddress,
        watchExpiration: gmailTenantMappings.watchExpiration,
        watchOwnerEnv: gmailTenantMappings.watchOwnerEnv,
      })
      .from(gmailTenantMappings)
      .where(eq(gmailTenantMappings.tenantId, userId))
      .limit(1);

    if (before.length === 0) {
      throw new UsageError(`No gmail_tenant_mappings row for tenant ${userId}.`);
    }

    out.section("Renew Gmail watch");
    out.keyValues([
      ["mailbox", before[0]!.emailAddress],
      ["tenant id", userId],
      ["expiration before", before[0]!.watchExpiration],
      ["owner env before", before[0]!.watchOwnerEnv],
    ]);

    out.line();
    await startGmailWatch(userId);

    const [after] = await db
      .select({
        watchExpiration: gmailTenantMappings.watchExpiration,
        watchTopic: gmailTenantMappings.watchTopic,
        watchOwnerEnv: gmailTenantMappings.watchOwnerEnv,
      })
      .from(gmailTenantMappings)
      .where(eq(gmailTenantMappings.tenantId, userId))
      .limit(1);

    out.success("users.watch registered.");
    out.keyValues([
      ["expiration now", after?.watchExpiration ?? null],
      ["watch topic", after?.watchTopic ?? null],
      ["owner env", after?.watchOwnerEnv ?? null],
    ]);
  },
});
