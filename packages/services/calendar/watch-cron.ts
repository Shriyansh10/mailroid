import { inngest } from "@repo/inngest";
import { db, eq, or, isNull, lt } from "@repo/database";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";
import { startCalendarWatch } from "./watch.js";

export const calendarWatchCron = inngest.createFunction(
  { id: "calendar-watch-cron" },
  [
    { cron: "0 0 * * *" }, // Daily cron (every 24 hours)
    { event: "calendar/watch.renew" } // Manual testing trigger
  ],
  async ({ step }) => {
    // 1. Get tenants whose watch is expiring within the next 48 hours or is never set (null)
    const tenants = await step.run("get-expiring-tenants", async () => {
      const targetTime = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      return await db
        .select({
          tenantId: calendarTenantMappings.tenantId,
          emailAddress: calendarTenantMappings.emailAddress,
          watchExpiration: calendarTenantMappings.watchExpiration,
        })
        .from(calendarTenantMappings)
        .where(
          or(
            isNull(calendarTenantMappings.watchExpiration),
            lt(calendarTenantMappings.watchExpiration, targetTime)
          )
        );
    });

    if (tenants.length === 0) {
      return { message: "No calendar watches require renewal at this time." };
    }

    const results = [];
    for (const tenant of tenants) {
      try {
        await step.run(`renew-${tenant.tenantId}`, async () => {
          await startCalendarWatch(tenant.tenantId);
        });
        results.push({ tenantId: tenant.tenantId, success: true });
      } catch (err) {
        console.error(`[cron] Failed to renew calendar watch for tenant "${tenant.tenantId}":`, err);
        results.push({ tenantId: tenant.tenantId, success: false, error: String(err) });
      }
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      console.error(
        `[calendar-watch-cron] ⚠️ ${failed.length}/${tenants.length} calendar watch renewals FAILED:`,
        JSON.stringify(failed),
      );
    } else {
      console.log(`[calendar-watch-cron] Renewed ${results.length}/${tenants.length} calendar watches successfully.`);
    }

    return { processed: tenants.length, succeeded: results.length - failed.length, failed: failed.length, results };
  }
);
