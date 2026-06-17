import { inngest } from "@repo/inngest";
import { db, eq, or, isNull, lt } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { startGmailWatch } from "./watch.js";

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

    const results = [];
    for (const tenant of tenants) {
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

    return { processed: tenants.length, results };
  }
);
