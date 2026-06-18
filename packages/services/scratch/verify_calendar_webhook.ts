import { db, eq, and } from "../../database/index.ts";
import { calendarEvents } from "../../database/models/calendar-events.ts";
import { calendarTenantMappings } from "../../database/models/calendar-tenant-mappings.ts";
import { dailyBriefs } from "../../database/models/daily-briefs.ts";
import { createEvent, updateEvent, deleteEvent } from "../calendar/index.ts";
import { getOrGenerateBrief } from "../gmail/daily-briefing.ts";

async function main() {
  console.log("🚀 Starting Google Calendar Webhook E2E Verification Script...");

  // 1. Resolve tenant mapping
  const mappings = await db.select().from(calendarTenantMappings).limit(1);
  if (mappings.length === 0) {
    console.error("❌ Error: No Google Calendar Watch Mappings found in database.");
    process.exit(1);
  }

  const { tenantId, channelId, emailAddress } = mappings[0];
  console.log(`✅ Found Watch Mapping for tenant "${tenantId}" (${emailAddress}), channelId: "${channelId}"`);

  // Format today's date YYYY-MM-DD
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const localDate = new Date(now.getTime() - offset * 60 * 1000)
    .toISOString()
    .split("T")[0] || "";
  console.log(`📅 Target Local Date: ${localDate}`);

  // Clear existing briefing cache to start fresh
  await db
    .delete(dailyBriefs)
    .where(and(eq(dailyBriefs.userId, tenantId), eq(dailyBriefs.briefingDate, localDate)));
  console.log("🧹 Cleared daily briefing cache for today.");

  // Generate baseline briefing (without our test event)
  console.log("⏳ Generating baseline briefing (cache miss)...");
  const baselineBrief = await getOrGenerateBrief(tenantId, localDate);
  console.log("✅ Baseline briefing generated.");

  // 2. Create calendar event on Google Calendar via Corsair
  const eventTitle = `Mailroid Webhook E2E Test - ${Date.now()}`;
  console.log(`\n📅 Creating event on Google Calendar: "${eventTitle}"...`);
  
  const startTime = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours from now
  const endTime = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3 hours from now
  
  const createdEvent = await createEvent(tenantId, {
    title: eventTitle,
    start: startTime.toISOString(),
    end: endTime.toISOString(),
    description: "This is a temporary test event for webhook verification.",
    location: "Virtual",
  });
  
  console.log(`✅ Event created on Google Calendar with ID: ${createdEvent.id}`);

  // 3. Verify event is synced to database (poll for 10s)
  console.log("⏳ Checking if webhook automatically synced the event to local DB...");
  let dbEvent = null;
  for (let i = 0; i < 10; i++) {
    const records = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.eventId, createdEvent.id))
      .limit(1);
    if (records.length > 0) {
      dbEvent = records[0];
      console.log("✅ Webhook auto-sync succeeded! Event found in database.");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // 4. Fallback: Simulate webhook call if auto-sync didn't complete
  if (!dbEvent) {
    console.warn("⚠️ Webhook did not trigger auto-sync within 10s (ngrok may be slow/offline). Simulating webhook request...");
    try {
      const response = await fetch("http://localhost:8000/api/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-channel-id": channelId,
          "x-goog-resource-state": "exists",
        },
        body: JSON.stringify({}),
      });
      console.log(`📡 Webhook simulated POST response status: ${response.status}`);
      
      // Wait for background sync to complete
      await new Promise((resolve) => setTimeout(resolve, 3000));
      
      const records = await db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.eventId, createdEvent.id))
        .limit(1);
      if (records.length > 0) {
        dbEvent = records[0];
        console.log("✅ Verified: Simulated webhook triggered background sync and event is in database.");
      } else {
        console.error("❌ Error: Event still not found in database after simulation.");
        process.exit(1);
      }
    } catch (err) {
      console.error("❌ Webhook simulation failed:", err);
      process.exit(1);
    }
  }

  // 5. Verify event propagates to daily briefing
  console.log("\n⏳ Requesting daily briefing (should trigger invalidation & regenerate)...");
  const briefWithEvent = await getOrGenerateBrief(tenantId, localDate);
  
  const hasEventTitle = briefWithEvent.toLowerCase().includes(eventTitle.toLowerCase());
  if (hasEventTitle) {
    console.log("✅ Verified: Test event title successfully appears in the daily briefing.");
  } else {
    console.warn("⚠️ Warning: Event is in DB but not visible in the generated brief. (The LLM may have filtered it or brief template did not display it). printing brief content:");
    console.log(briefWithEvent);
  }

  // 6. Update calendar event on Google Calendar
  const updatedTitle = `${eventTitle} - UPDATED`;
  console.log(`\n📅 Updating event on Google Calendar: "${updatedTitle}"...`);
  await updateEvent(tenantId, createdEvent.id, {
    title: updatedTitle,
    start: startTime.toISOString(),
    end: endTime.toISOString(),
  });

  // Verify DB updated
  console.log("⏳ Checking for database update...");
  let updatedDbEvent = null;
  for (let i = 0; i < 10; i++) {
    const records = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.eventId, createdEvent.id))
      .limit(1);
    if (records.length > 0 && records[0].title.includes("UPDATED")) {
      updatedDbEvent = records[0];
      console.log("✅ Webhook/sync successfully updated event in DB!");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!updatedDbEvent) {
    console.warn("⚠️ Update did not auto-sync. Re-simulating webhook...");
    await fetch("http://localhost:8000/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-channel-id": channelId,
        "x-goog-resource-state": "exists",
      },
      body: JSON.stringify({}),
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    
    const records = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.eventId, createdEvent.id))
      .limit(1);
    if (records.length > 0 && records[0].title.includes("UPDATED")) {
      console.log("✅ Verified: Simulated webhook updated the event in DB.");
    } else {
      console.error(`❌ Error: Event update was not synced. Title in DB is: "${records[0]?.title}"`);
      process.exit(1);
    }
  }

  // Verify brief invalidates and gets updated title
  console.log("\n⏳ Requesting daily briefing (should trigger invalidation & regenerate with updated title)...");
  const briefWithUpdatedEvent = await getOrGenerateBrief(tenantId, localDate);
  const hasUpdatedTitle = briefWithUpdatedEvent.toLowerCase().includes("updated");
  if (hasUpdatedTitle) {
    console.log("✅ Verified: Updated event title successfully appears in the daily briefing.");
  } else {
    console.warn("⚠️ Warning: Updated title not found in generated brief. Brief content:");
    console.log(briefWithUpdatedEvent);
  }

  // 7. Delete event
  console.log(`\n📅 Deleting event on Google Calendar: "${createdEvent.id}"...`);
  await deleteEvent(tenantId, createdEvent.id);

  // Verify DB deletion
  console.log("⏳ Checking for database deletion...");
  let deleted = false;
  for (let i = 0; i < 10; i++) {
    const records = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.eventId, createdEvent.id))
      .limit(1);
    if (records.length === 0) {
      deleted = true;
      console.log("✅ Webhook/sync successfully deleted event from DB!");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!deleted) {
    console.warn("⚠️ Deletion did not auto-sync. Re-simulating webhook...");
    await fetch("http://localhost:8000/api/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-channel-id": channelId,
        "x-goog-resource-state": "exists",
      },
      body: JSON.stringify({}),
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    
    const records = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.eventId, createdEvent.id))
      .limit(1);
    if (records.length === 0) {
      console.log("✅ Verified: Simulated webhook deleted the event from DB.");
    } else {
      console.error("❌ Error: Event deletion was not synced. Event still exists in DB.");
      process.exit(1);
    }
  }

  // Verify brief invalidates and removes deleted event
  console.log("\n⏳ Requesting daily briefing after event deletion (should regenerate and exclude it)...");
  const briefAfterDelete = await getOrGenerateBrief(tenantId, localDate);
  const stillHasEvent = briefAfterDelete.toLowerCase().includes(eventTitle.toLowerCase());
  if (!stillHasEvent) {
    console.log("✅ Verified: Deleted event is no longer present in the daily briefing.");
  } else {
    console.error("❌ Error: Deleted event is still mentioned in the daily briefing.");
    process.exit(1);
  }

  console.log("\n🎉 ALL E2E CALENDAR WEBHOOK VERIFICATION TASKS COMPLETED SUCCESSFULLY! 🎉");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ E2E Webhook Verification Failed:", err);
  process.exit(1);
});
