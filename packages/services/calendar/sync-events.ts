import { corsair } from "@repo/corsair";
import { db, sql, and, eq, gte, lte, inArray } from "@repo/database";
import { calendarEvents } from "@repo/database/models/calendar-events";

export async function syncCalendarEvents(tenantId: string): Promise<void> {
  console.log(`[sync-calendar-events] Starting sync for tenant: ${tenantId}`);
  const tenant = corsair.withTenant(tenantId);

  // Sync range: 7 days ago to 30 days in the future
  const timeMin = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const response = await tenant.googlecalendar.api.events.getMany({
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
    });

    const items = response.items ?? [];
    console.log(`[sync-calendar-events] Fetched ${items.length} events from Google Calendar API for tenant ${tenantId}`);

    // Reconcile deletions: Find all events in the local DB for this tenant within this range
    const timeMinDate = new Date(timeMin);
    const timeMaxDate = new Date(timeMax);

    const dbEvents = await db
      .select({ eventId: calendarEvents.eventId })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.userId, tenantId),
          gte(calendarEvents.startTime, timeMinDate),
          lte(calendarEvents.startTime, timeMaxDate)
        )
      );

    const dbEventIds = dbEvents.map((e) => e.eventId);
    const fetchedEventIds = new Set(items.map((item: any) => item.id).filter(Boolean));

    const deletedEventIds = dbEventIds.filter((id) => !fetchedEventIds.has(id));
    if (deletedEventIds.length > 0) {
      console.log(`[sync-calendar-events] Deleting ${deletedEventIds.length} obsolete events from DB for tenant ${tenantId}:`, deletedEventIds);
      await db
        .delete(calendarEvents)
        .where(
          and(
            eq(calendarEvents.userId, tenantId),
            inArray(calendarEvents.eventId, deletedEventIds)
          )
        );
    }

    if (items.length === 0) {
      console.log(`[sync-calendar-events] No events to sync/upsert for tenant ${tenantId}`);
      return;
    }

    const values = items.map((event: any) => {
      const start = event.start?.dateTime ?? event.start?.date;
      const end = event.end?.dateTime ?? event.end?.date;
      return {
        userId: tenantId,
        eventId: event.id,
        title: event.summary ?? "(No title)",
        startTime: start ? new Date(start) : new Date(),
        endTime: end ? new Date(end) : new Date(),
        description: event.description ?? null,
        location: event.location ?? null,
        organizerEmail: event.organizer?.email ?? null,
        attendees: event.attendees ?? null,
        status: event.status ?? null,
        htmlLink: event.htmlLink ?? null,
        updatedAtGoogle: event.updated ? new Date(event.updated) : null,
      };
    });

    // Bulk upsert into calendar_events table
    await db
      .insert(calendarEvents)
      .values(values)
      .onConflictDoUpdate({
        target: calendarEvents.eventId,
        set: {
          title: sql`EXCLUDED.title`,
          startTime: sql`EXCLUDED.start_time`,
          endTime: sql`EXCLUDED.end_time`,
          description: sql`EXCLUDED.description`,
          location: sql`EXCLUDED.location`,
          organizerEmail: sql`EXCLUDED.organizer_email`,
          attendees: sql`EXCLUDED.attendees`,
          status: sql`EXCLUDED.status`,
          htmlLink: sql`EXCLUDED.html_link`,
          updatedAtGoogle: sql`EXCLUDED.updated_at_google`,
          updatedAt: new Date(),
        },
      });

    console.log(`[sync-calendar-events] Successfully reconciled ${items.length} events in DB for tenant ${tenantId}`);
  } catch (error) {
    console.error(`[sync-calendar-events] Sync failed for tenant ${tenantId}:`, error);
    throw error;
  }
}
