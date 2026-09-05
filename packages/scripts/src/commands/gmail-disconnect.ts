/**
 * Fully disconnect a mailbox from this environment (P-9,
 * docs/gmail-rate-limit-boundary.md §13).
 *
 * The operator action for a mailbox that should never have been connected
 * here at all — §8.4's confirmed local/production overlap, mainly. Reuses
 * `rollbackGmailConnection` (tenant/index.ts), which already: best-effort
 * releases the watch (P-2, when one is recorded), deletes the corsair
 * account and its synced entities/events, deletes the gmail_tenant_mappings
 * row, and clears the stored connection email. That function was written for
 * the OAuth-callback failure path, but its actual behaviour — undo this
 * environment's claim on this mailbox, safely, even with no mapping present
 * — is exactly what disconnecting-by-mistake needs too, so this is a thin
 * confirmation-gated wrapper rather than a second implementation.
 *
 * Unlike `gmail:release-watch`, this removes the connection entirely — the
 * user will see "Connect Gmail" again, and reconnecting re-runs the P-1
 * allowlist check from scratch.
 */

import { db, eq } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { rollbackGmailConnection } from "@repo/services/tenant/index.js";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import { confirmDestructive, hasYesFlag, stripYesFlag } from "../lib/confirm.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "gmail:disconnect",
  description: "Fully disconnect a mailbox from this environment",
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
      })
      .from(gmailTenantMappings)
      .where(eq(gmailTenantMappings.tenantId, userId))
      .limit(1);

    out.section("Disconnect Gmail mailbox");
    out.keyValues([
      ["input", arg],
      ["tenant id", userId],
      ["mailbox", mapping?.emailAddress ?? out.dim("(no mapping row — corsair account only)")],
      ["recorded watch owner env", mapping?.watchOwnerEnv ?? null],
    ]);

    out.line();
    const targetLabel = mapping?.emailAddress ?? `tenant ${userId}`;
    const confirmed = await confirmDestructive(
      `This will best-effort release the watch, then delete the corsair account, ` +
        `synced entities/events and mapping row for ${targetLabel}. The user will see ` +
        `"Connect Gmail" again.`,
      skipPrompt,
    );
    if (!confirmed) {
      out.warn("Aborted.");
      return;
    }

    const os = await import("node:os");
    out.line();
    out.line(out.dim(`Run by ${os.userInfo().username}@${os.hostname()} at ${new Date().toISOString()}`));

    await rollbackGmailConnection(userId);
    out.success(`Disconnected ${targetLabel}.`);
  },
});
