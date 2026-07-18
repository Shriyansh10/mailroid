import { db, sql, eq } from "@repo/database";
import { calendarTenantMappings } from "@repo/database/models/calendar-tenant-mappings";

/**
 * Cheap per-user change token for the calendar, mirroring gmail's
 * getInboxVersion. The client polls this and only re-fetches its cached event
 * lists when the value grows, so a webhook that touches THIS user's calendar
 * refreshes only them.
 *
 * Unlike the mail version (which reads max(updatedAt) over message rows), we
 * base this on the tenant's calendar_tenant_mappings.updatedAt and bump that row
 * on every sync that changed data (see touchCalendarVersion, called from
 * syncCalendarEvents). Event rows alone can't detect a pure deletion — the
 * newest remaining updatedAt could go *down* — and calendar deletions are
 * common, so a monotonic per-tenant marker is the deletion-safe choice.
 */
export async function getCalendarVersion(userId: string): Promise<{ version: number }> {
  const rows = await db
    .select({ max: sql<string | null>`max(${calendarTenantMappings.updatedAt})` })
    .from(calendarTenantMappings)
    .where(eq(calendarTenantMappings.tenantId, userId));

  const maxUpdatedAt = rows[0]?.max;
  const version = maxUpdatedAt ? new Date(maxUpdatedAt).getTime() : 0;
  return { version };
}

/**
 * Bump the per-tenant calendar change token. Call after a sync that actually
 * changed local data so the client's next poll sees a higher version and
 * re-fetches. Touches every mapping row for the tenant (a tenant normally has
 * one). No-op if the tenant has no mapping yet.
 */
export async function touchCalendarVersion(userId: string): Promise<void> {
  await db
    .update(calendarTenantMappings)
    .set({ updatedAt: new Date() })
    .where(eq(calendarTenantMappings.tenantId, userId));
}
