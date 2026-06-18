import { createEvent, getEvent, deleteEvent, buildEventTime, resolveTimezone } from "../calendar/index.ts";

async function main() {
  console.log("=== Mailroid Timezone Offset Regression Test Suite ===");
  const tenantId = "I18zlIaeuH86k4fZhzGM0B0BPgMaGGMw"; // Active test tenant

  // --- PART 1: Unit Test the buildEventTime Helper ---
  console.log("\n--- PART 1: Testing buildEventTime Helper ---");
  
  const resKolkata = buildEventTime("2026-06-19T17:00:00", false, "Asia/Kolkata");
  console.log(`- ISO local string + Asia/Kolkata timezone:`, JSON.stringify(resKolkata));
  if (resKolkata.dateTime === "2026-06-19T17:00:00" && resKolkata.timeZone === "Asia/Kolkata") {
    console.log("✅ buildEventTime Asia/Kolkata check passed");
  } else {
    console.error("❌ buildEventTime Asia/Kolkata check failed");
    process.exit(1);
  }

  const resUTC = buildEventTime("2026-06-19T17:00:00", false, "UTC");
  console.log(`- ISO local string + UTC timezone:`, JSON.stringify(resUTC));
  if (resUTC.dateTime === "2026-06-19T17:00:00" && resUTC.timeZone === "UTC") {
    console.log("✅ buildEventTime UTC check passed");
  } else {
    console.error("❌ buildEventTime UTC check failed");
    process.exit(1);
  }

  const resOffset = buildEventTime("2026-06-19T17:00:00+05:30", false, "UTC");
  console.log(`- ISO string with offset:`, JSON.stringify(resOffset));
  if (resOffset.dateTime === "2026-06-19T17:00:00+05:30" && !resOffset.timeZone) {
    console.log("✅ buildEventTime offset-preservation check passed");
  } else {
    console.error("❌ buildEventTime offset-preservation check failed");
    process.exit(1);
  }


  // --- PART 2: Unit Test the resolveTimezone Precedence ---
  console.log("\n--- PART 2: Testing resolveTimezone Hierarchy ---");

  // 1. Google Calendar setting (should return Asia/Kolkata since it's the system of record)
  console.log("Resolving timezone with valid tenant (should resolve to calendar settings):");
  const tz1 = await resolveTimezone(tenantId, "UTC");
  console.log(`Resolved Timezone: "${tz1}" (Expect: Asia/Kolkata)`);
  if (tz1 === "Asia/Kolkata") {
    console.log("✅ System of Record priority check passed");
  } else {
    console.error("❌ System of Record priority check failed");
    process.exit(1);
  }

  // 2. Fallback to Browser timezone (when API check fails)
  console.log("Resolving timezone with invalid tenant (should fall back to browser timezone):");
  const tz2 = await resolveTimezone("invalid-tenant-id", "America/New_York");
  console.log(`Resolved Timezone: "${tz2}" (Expect: America/New_York)`);
  if (tz2 === "America/New_York") {
    console.log("✅ Browser fallback check passed");
  } else {
    console.error("❌ Browser fallback check failed");
    process.exit(1);
  }

  // 3. Fallback to UTC (when both API and browser timezone are absent)
  console.log("Resolving timezone with invalid tenant and no browser timezone (should fall back to UTC):");
  const tz3 = await resolveTimezone("invalid-tenant-id");
  console.log(`Resolved Timezone: "${tz3}" (Expect: UTC)`);
  if (tz3 === "UTC") {
    console.log("✅ UTC fallback check passed");
  } else {
    console.error("❌ UTC fallback check failed");
    process.exit(1);
  }


  // --- PART 3: End-to-End Google Calendar Assertions ---
  console.log("\n--- PART 3: E2E Event Time Verification (System of Record) ---");
  const istDate = "2026-06-19";
  const istStart = "17:00:00";
  const istEnd = "18:00:00";
  const istTimeZone = "Asia/Kolkata";

  console.log(`Creating event on Google Calendar: "E2E Timezone Regression Test" at ${istDate}T${istStart} (${istTimeZone})...`);
  const event = await createEvent(tenantId, {
    title: "E2E Timezone Regression Test",
    start: `${istDate}T${istStart}`,
    end: `${istDate}T${istEnd}`,
    description: "Temporary event created by regression tests to verify local time scheduling.",
  }, istTimeZone);

  console.log(`✅ Event created with ID: ${event.id}`);

  // Fetch back from Google Calendar API to assert timezone interpretation
  console.log("Fetching event back from Google Calendar to check local start time hour...");
  const retrieved = await getEvent(tenantId, event.id);
  console.log(`Retrieved event start time string: "${retrieved.start}"`);

  // Format retrieved start time to local hours in Asia/Kolkata
  const dateObj = new Date(retrieved.start);
  const formattedHour = new Intl.DateTimeFormat("en-US", {
    timeZone: istTimeZone,
    hour: "numeric",
    hour12: false,
  }).format(dateObj);

  console.log(`Retrieved start time formatted in ${istTimeZone}: ${formattedHour} (Expect: 17)`);

  if (parseInt(formattedHour, 10) === 17) {
    console.log("✅ SUCCESS: Event is scheduled at exactly 5:00 PM IST in Google Calendar (Timezone Resolution verified)!");
  } else {
    console.error(`❌ FAILURE: Event is scheduled at hour ${formattedHour} instead of 17.`);
    await deleteEvent(tenantId, event.id);
    process.exit(1);
  }

  // Clean up
  console.log("Cleaning up E2E event...");
  await deleteEvent(tenantId, event.id);
  console.log("✅ E2E event cleaned up.");

  console.log("\n🎉 ALL REGRESSION TESTS COMPLETED SUCCESSFULLY! 🎉");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Regression Test Suite Failed:", err);
  process.exit(1);
});
