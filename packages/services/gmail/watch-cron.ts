import { inngest } from "@repo/inngest";
import { db, eq, or, isNull, lt } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { logger } from "@repo/logger";
import { startGmailWatch } from "./watch.ts";
import { getPausedTenantIds, isTenantPaused } from "./pause.ts";
import { isMailboxAllowedInThisEnvironment, mailroidEnv } from "../env.ts";

export const gmailWatchCron = inngest.createFunction(
  { id: "gmail-watch-cron" },
  [
    { cron: "0 0 * * *" }, // Daily cron (every 24 hours)
    { event: "gmail/watch.renew" } // Manual testing trigger
  ],
  async ({ step }) => {
    // 1. Get tenants whose watch is expiring within the next 48 hours or is never set (null)
    const tenants = await step.run("get-expiring-tenants", async () => {
      const targetTime = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      return await db
        .select({
          tenantId: gmailTenantMappings.tenantId,
          emailAddress: gmailTenantMappings.emailAddress,
          watchExpiration: gmailTenantMappings.watchExpiration,
        })
        .from(gmailTenantMappings)
        .where(
          or(
            isNull(gmailTenantMappings.watchExpiration),
            lt(gmailTenantMappings.watchExpiration, targetTime)
          )
        );
    });

    if (tenants.length === 0) {
      return { message: "No watches require renewal at this time." };
    }

    // Mailboxes this environment does not own are dropped before anything else
    // (P-1 + P-11). A renewal REPLACES the single watch Gmail holds per mailbox,
    // so renewing one that belongs to another environment silently repoints its
    // notifications here and leaves the real owner deaf. startGmailWatch refuses
    // these too; filtering here just avoids the wasted calls, same as pauses.
    const owned = tenants.filter((t) => isMailboxAllowedInThisEnvironment(t.emailAddress));

    if (owned.length < tenants.length) {
      logger.info("[gmail-watch-cron] skipping mailboxes owned by another environment", {
        skipped: tenants.length - owned.length,
        mailroidEnv: mailroidEnv.env,
      });
    }

    if (owned.length === 0) {
      return { message: "All due watches belong to another environment.", skippedNotOwned: tenants.length };
    }

    // Only pauses that explicitly block renewal are honoured here. users.watch
    // keeps the SUBSCRIPTION alive and reads no mailbox content, so an ordinary
    // pause deliberately lets it through — dropping the channel would cost a
    // re-registration for no benefit. startGmailWatch re-checks this itself;
    // filtering here just avoids the wasted calls.
    const pausedForWatch = await step.run("find-watch-paused-tenants", async () => [
      ...(await getPausedTenantIds({ forWatchRenewal: true })),
    ]);
    const pausedSet = new Set(pausedForWatch);
    const renewable = owned.filter((t) => !isTenantPaused(pausedSet, t.tenantId));

    if (renewable.length === 0) {
      return { message: "All due watches belong to paused mailboxes.", skippedPaused: owned.length };
    }

    const results = [];
    for (const tenant of renewable) {
      try {
        await step.run(`renew-${tenant.tenantId}`, async () => {
          await startGmailWatch(tenant.tenantId);
        });
        results.push({ tenantId: tenant.tenantId, success: true });
      } catch (err) {
        console.error(`[cron] Failed to renew watch for tenant "${tenant.tenantId}":`, err);
        results.push({ tenantId: tenant.tenantId, success: false, error: String(err) });
      }
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      console.error(
        `[gmail-watch-cron] ⚠️ ${failed.length}/${renewable.length} Gmail watch renewals FAILED:`,
        JSON.stringify(failed),
      );
    } else {
      console.log(`[gmail-watch-cron] Renewed ${results.length}/${renewable.length} Gmail watches successfully.`);
    }

    return {
      processed: renewable.length,
      skippedPaused: tenants.length - renewable.length,
      succeeded: results.length - failed.length,
      failed: failed.length,
      results,
    };
  }
);
