/**
 * Release a mailbox's Gmail watch slot (P-9, docs/gmail-rate-limit-boundary.md
 * §13).
 *
 * The operator action for what /api/_debug/watch-health's `orphans` array
 * makes visible: a mapping this environment's database holds whose recorded
 * `watchOwnerEnv` names a different environment. Releasing calls users.stop
 * (50 units) so Google actually drops the slot — leaving the mapping row,
 * the OAuth token and everything else about the connection untouched. Use
 * `gmail:disconnect` instead when the whole connection should go.
 */

import { db, eq } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { stopGmailWatch } from "@repo/services/gmail/watch.js";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import { confirmDestructive, hasYesFlag, stripYesFlag } from "../lib/confirm.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "gmail:release-watch",
  description: "Stop a mailbox's Gmail watch and clear recorded ownership",
  usage: "<userId|email> [--yes]",
  destructive: true,

  async run(rawArgs) {
    const skipPrompt = hasYesFlag(rawArgs);
    const args = stripYesFlag(rawArgs);

    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "gmail");
    if (!userId) throw new UsageError(`No Gmail tenant found for "${arg}".`);

    const [mapping] = await db
      .select({
        emailAddress: gmailTenantMappings.emailAddress,
        watchTopic: gmailTenantMappings.watchTopic,
        watchOwnerEnv: gmailTenantMappings.watchOwnerEnv,
        watchExpiration: gmailTenantMappings.watchExpiration,
      })
      .from(gmailTenantMappings)
      .where(eq(gmailTenantMappings.tenantId, userId))
      .limit(1);

    if (!mapping) throw new UsageError(`No gmail_tenant_mappings row for tenant ${userId}.`);

    const watchLive =
      mapping.watchExpiration !== null && mapping.watchExpiration.getTime() > Date.now();

    out.section("Release Gmail watch");
    out.keyValues([
      ["input", arg],
      ["tenant id", userId],
      ["mailbox", mapping.emailAddress],
      ["recorded watch topic", mapping.watchTopic],
      ["recorded owner env", mapping.watchOwnerEnv],
      ["watch expiration", mapping.watchExpiration?.toISOString() ?? null],
    ]);

    // WATCH EXPIRATION IS THE SIGNAL, NOT THE OWNERSHIP COLUMNS.
    //
    // watchTopic and watchOwnerEnv arrived in migration 0045 and are stamped
    // only when THIS code registers a watch, so every watch registered before
    // that migration has both null while Gmail is still very much pushing for
    // it. Bailing on those two alone made this command refuse to release
    // exactly the watches an operator most needs to release — the pre-existing
    // ones — and report "nothing to release" about a live subscription.
    if (!watchLive && !mapping.watchTopic && !mapping.watchOwnerEnv) {
      out.line();
      out.line(out.dim("No live watch and no recorded ownership — nothing to release."));
      return;
    }

    if (watchLive && !mapping.watchTopic && !mapping.watchOwnerEnv) {
      out.line();
      out.warn(
        "Live watch with no recorded ownership — registered before ownership tracking. " +
          "users.stop will still be called.",
      );
    }

    out.line();
    const confirmed = await confirmDestructive(
      `This will call users.stop for mailbox ${mapping.emailAddress}, ` +
        `releasing whatever watch Gmail currently holds for it.`,
      skipPrompt,
    );
    if (!confirmed) {
      out.warn("Aborted.");
      return;
    }

    // Who ran this — the CLI has no auth layer (see types.ts), so the OS
    // identity is the only "who" available, and it's better than nothing on
    // an action that changes what Google is doing for a live mailbox.
    const os = await import("node:os");
    out.line();
    out.line(out.dim(`Run by ${os.userInfo().username}@${os.hostname()} at ${new Date().toISOString()}`));

    const result = await stopGmailWatch(userId);
    if (result.stopped) {
      out.success(`Released — recorded ownership cleared for ${mapping.emailAddress}.`);
    } else {
      out.error(`Not released: ${result.reason ?? "unknown reason"}. Recorded ownership was retained.`);
      process.exitCode = 1;
    }
  },
});
