import { createEvent } from "../calendar/index.ts";
import { corsair } from "@repo/corsair";

async function main() {
  console.log("=== Mailroid Timezone Offset Audit & Reproduction ===");
  const tenantId = "I18zlIaeuH86k4fZhzGM0B0BPgMaGGMw"; // Active test tenant

  // Input Parameters representing "Tomorrow 5pm to 6pm in Asia/Kolkata"
  const localDate = "2026-06-19";
  const startLocalTime = "17:00:00";
  const endLocalTime = "18:00:00";
  const userTimeZone = "Asia/Kolkata";

  console.log("\n1. LLM Output Simulation:");
  const llmOutput = {
    start: `${localDate}T${startLocalTime}`,
    end: `${localDate}T${endLocalTime}`,
  };
  console.log(JSON.stringify(llmOutput, null, 2));

  console.log("\n2. Approval Payload Simulation:");
  const approvalPayload = {
    toolName: "createEvent",
    args: {
      title: "Business Call Meeting",
      start: llmOutput.start,
      end: llmOutput.end,
    }
  };
  console.log(JSON.stringify(approvalPayload, null, 2));

  console.log("\n3. Executor Payload (Start of Transformation):");
  const executorInput = {
    title: approvalPayload.args.title,
    start: approvalPayload.args.start,
    end: approvalPayload.args.end,
  };
  console.log(JSON.stringify(executorInput, null, 2));

  // --- Step 4: Show what happens UNDER THE OLD UTC-FALLBACK IMPLEMENTATION ---
  console.log("\n4. Calendar Service Payload (UTC Hardcoded/Fallback):");
  
  // Custom local copy of buildEventTime from packages/services/calendar/index.ts (original)
  function buildEventTimeOriginal(isoString: string): { dateTime: string; timeZone: string } {
    const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(isoString);
    if (hasOffset) {
      return { dateTime: isoString, timeZone: "" }; // simplified
    }
    return { dateTime: isoString, timeZone: "UTC" };
  }

  const calendarPayloadOriginal = {
    summary: executorInput.title,
    start: buildEventTimeOriginal(executorInput.start),
    end: buildEventTimeOriginal(executorInput.end),
  };
  console.log(JSON.stringify(calendarPayloadOriginal, null, 2));

  // --- Step 5: Show the payload Google API receives with original logic ---
  console.log("\n5. Google API Payload (Original):");
  console.log(JSON.stringify({
    event: calendarPayloadOriginal
  }, null, 2));
  console.log("⚠️ Time Shift Point: Google Calendar receives '2026-06-19T17:00:00' with 'UTC' timezone.");
  console.log("   This means the event starts at 5:00 PM UTC, which is 10:30 PM IST (Asia/Kolkata).");
  console.log("   This causes a +5:30 hour shift when viewed on the user's IST calendar.");

  // --- Step 6: Show what happens WITH THE PROPOSED FIX ---
  console.log("\n6. Calendar Service Payload (Proposed Fix with userTimeZone):");
  
  function buildEventTimeFixed(isoString: string, userTZ: string): { dateTime: string; timeZone: string } {
    const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(isoString);
    if (hasOffset) {
      return { dateTime: isoString, timeZone: "" };
    }
    return { dateTime: isoString, timeZone: userTZ };
  }

  const calendarPayloadFixed = {
    summary: executorInput.title,
    start: buildEventTimeFixed(executorInput.start, userTimeZone),
    end: buildEventTimeFixed(executorInput.end, userTimeZone),
  };
  console.log(JSON.stringify(calendarPayloadFixed, null, 2));

  console.log("\n7. Google API Payload (Fixed):");
  console.log(JSON.stringify({
    event: calendarPayloadFixed
  }, null, 2));
  console.log("✅ Fixed State: Google Calendar receives '2026-06-19T17:00:00' with 'Asia/Kolkata' timezone.");
  console.log("   This correctly schedules the event at 5:00 PM IST local time.");

  process.exit(0);
}

main().catch(console.error);
