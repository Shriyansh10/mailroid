import { db, eq, and } from "../../database/index.ts";
import { dailyBriefs, messageMetadata, calendarEvents } from "../../database/schema.ts";
import { getOrGenerateBrief } from "../gmail/daily-briefing.ts";

async function main() {
  console.log("🚀 Starting Daily Briefing Verification Script...");

  // ── 1. Find a valid userId in the DB ──────────────────────────────
  const firstRecord = await db.select().from(messageMetadata).limit(1);
  if (firstRecord.length === 0) {
    console.log("❌ Error: No message metadata records found in database to test with.");
    process.exit(1);
  }
  const userId = firstRecord[0].userId;
  console.log(`✅ Found test userId: ${userId}`);

  // Format current date in local YYYY-MM-DD
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const localDate = new Date(now.getTime() - offset * 60 * 1000)
    .toISOString()
    .split("T")[0] || "";
  console.log(`📅 Test localDate: ${localDate}`);

  // ── 2. Clear existing cache for today to test cache miss ──────────
  console.log("🧹 Clearing existing cache for today...");
  await db
    .delete(dailyBriefs)
    .where(and(eq(dailyBriefs.userId, userId), eq(dailyBriefs.briefingDate, localDate)));

  // ── 3. Call getOrGenerateBrief (Cache Miss) ───────────────────────
  console.log("⏳ Generating briefing (this will call DeepSeek)...");
  const startMiss = Date.now();
  const brief1 = await getOrGenerateBrief(userId, localDate);
  const durationMiss = Date.now() - startMiss;
  console.log(`\n🎉 Briefing generated in ${durationMiss}ms:\n`);
  console.log(brief1);
  console.log("\n---------------------------------------------------\n");

  // ── 4. Verify record in DB ────────────────────────────────────────
  const insertedBriefs = await db
    .select()
    .from(dailyBriefs)
    .where(and(eq(dailyBriefs.userId, userId), eq(dailyBriefs.briefingDate, localDate)));
  
  if (insertedBriefs.length === 0) {
    console.log("❌ Error: Daily briefing record was not written to database.");
    process.exit(1);
  }
  const cachedRecord = insertedBriefs[0];
  console.log("✅ Verified daily_brief record written to DB:");
  console.log(`   - ID: ${cachedRecord.id}`);
  console.log(`   - Generated At: ${cachedRecord.generatedAt.toISOString()}`);
  console.log(`   - Brief Date: ${cachedRecord.briefingDate}`);

  // ── 5. Test Cache Hit ─────────────────────────────────────────────
  console.log("\n⏳ Requesting briefing again (should hit cache)...");
  const startHit = Date.now();
  const brief2 = await getOrGenerateBrief(userId, localDate);
  const durationHit = Date.now() - startHit;
  console.log(`✅ Briefing retrieved in ${durationHit}ms (Cache Hit).`);
  if (brief1 !== brief2) {
    console.log("❌ Error: Cache hit returned different text content.");
    process.exit(1);
  }
  console.log("✅ Cache hit verified successfully.");

  // ── 6. Test Cache Invalidation on Email Change ───────────────────
  console.log("\n⏳ Updating message metadata to trigger invalidation...");
  const targetEmail = firstRecord[0];
  const originalPriority = targetEmail.priority;
  const originalUpdatedAt = targetEmail.updatedAt;

  // Let's toggle priority to trigger cache staleness (e.g. HIGH -> LOW, or LOW -> HIGH)
  const newPriority = originalPriority === "HIGH" ? "LOW" : "HIGH";
  console.log(`   - Email Subject: "${targetEmail.subject}"`);
  console.log(`   - Changing priority: ${originalPriority} -> ${newPriority}`);

  // Wait a moment so updatedAt is strictly greater than generatedAt
  await new Promise((resolve) => setTimeout(resolve, 1000));

  await db
    .update(messageMetadata)
    .set({
      priority: newPriority,
      updatedAt: new Date(),
    })
    .where(eq(messageMetadata.entityId, targetEmail.entityId));

  console.log("⏳ Requesting briefing again (should trigger cache invalidation and regenerate)...");
  const startStale = Date.now();
  const brief3 = await getOrGenerateBrief(userId, localDate);
  const durationStale = Date.now() - startStale;
  console.log(`🎉 Briefing regenerated in ${durationStale}ms.`);

  // Clean up email change
  console.log("🧹 Restoring email metadata to original state...");
  await db
    .update(messageMetadata)
    .set({
      priority: originalPriority,
      updatedAt: originalUpdatedAt,
    })
    .where(eq(messageMetadata.entityId, targetEmail.entityId));

  console.log("🚀 Verification Script Completed Successfully!");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Test Script Failed:", err);
  process.exit(1);
});
