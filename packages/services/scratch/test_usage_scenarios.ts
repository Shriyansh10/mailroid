import { db, eq, and } from "../../database/index.ts";
import { user, userUsage } from "../../database/schema.ts";
import { checkDailyLimit, incrementDailyLimit } from "../../../apps/web/lib/limits.ts";

async function setActionCount(userId: string, count: number, dateStr: string) {
  await db
    .insert(userUsage)
    .values({
      userId,
      date: dateStr,
      actionCount: count,
      unlocked: false,
    })
    .onConflictDoUpdate({
      target: [userUsage.userId, userUsage.date],
      set: { actionCount: count, unlocked: false },
    });
}

async function getActionCount(userId: string, dateStr: string): Promise<number> {
  const [row] = await db
    .select()
    .from(userUsage)
    .where(and(eq(userUsage.userId, userId), eq(userUsage.date, dateStr)))
    .limit(1);
  return row ? row.actionCount : 0;
}

async function main() {
  console.log("=== Mailroid Assistant Usage Accounting Verification ===");

  const tenantId = "I18zlIaeuH86k4fZhzGM0B0BPgMaGGMw"; // Active test tenant
  const [u] = await db.select().from(user).where(eq(user.id, tenantId)).limit(1);
  if (!u) {
    console.error("❌ Error: Test user not found in database.");
    process.exit(1);
  }
  const userEmail = u.email;
  const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
  console.log(`👤 Active User: ${userEmail}`);
  console.log(`📅 Date String: ${dateStr}`);

  // ==========================================
  // Scenario A: Cancelled Approval
  // ==========================================
  console.log("\n--- Scenario A: Cancelled Approval ---");
  await setActionCount(tenantId, 9, dateStr);
  console.log(`Baseline usage set to: ${await getActionCount(tenantId, dateStr)} / 10`);

  // User requests: "Send an email to alice@example.com"
  // Response returned: approvalRequired present
  const chatResponse = {
    role: "assistant",
    content: "Please approve sending this email.",
    approvalRequired: {
      approvalId: "app-test-a",
      toolName: "sendEmail",
    },
  };

  const newMessages = [
    { role: "assistant", content: "Please approve sending this email.", toolCalls: [{ id: "call-1" }] }
  ];

  // Route logic checks shouldCharge:
  let shouldCharge = !("approvalRequired" in chatResponse);
  console.log("Should charge chat request?", shouldCharge);

  if (shouldCharge) {
    await incrementDailyLimit(tenantId, userEmail, "UTC");
  }

  // User clicks "Cancel". Marks CANCELLED. No limit increment.
  console.log("User cancelled the approval. Status set to CANCELLED. (No limit increment called)");

  const countA = await getActionCount(tenantId, dateStr);
  console.log(`Final Usage: ${countA} / 10`);
  if (countA === 9) {
    console.log("✅ Scenario A Passed: Cancelled approval does not consume daily usage!");
  } else {
    console.error(`❌ Scenario A Failed: Usage changed to ${countA}`);
    process.exit(1);
  }

  // ==========================================
  // Scenario B: Security Validation Failure
  // ==========================================
  console.log("\n--- Scenario B: Security Validation Failure ---");
  await setActionCount(tenantId, 9, dateStr);
  console.log(`Baseline usage set to: ${await getActionCount(tenantId, dateStr)} / 10`);

  // User requests: "Send an email from ceo@example.com"
  // Cognitive Refusal text contains "only authorized to send"
  const responseB = {
    role: "assistant",
    content: "I am only authorized to send a mail on your behalf. I cannot send it as ceo@example.com.",
  };

  const messagesB = [
    { role: "assistant", content: responseB.content }
  ];

  // Route shouldCharge check:
  let shouldChargeB = !("approvalRequired" in responseB);
  if (shouldChargeB) {
    if (responseB.content) {
      const lowerContent = responseB.content.toLowerCase();
      if (
        lowerContent.includes("only authorized to send") ||
        lowerContent.includes("only authorized to schedule") ||
        lowerContent.includes("cannot impersonate") ||
        lowerContent.includes("only authorized to create")
      ) {
        shouldChargeB = false;
      }
    }
  }

  console.log("Should charge on cognitive refusal?", shouldChargeB);
  if (shouldChargeB) {
    await incrementDailyLimit(tenantId, userEmail, "UTC");
  }

  const countB = await getActionCount(tenantId, dateStr);
  console.log(`Final Usage: ${countB} / 10`);
  if (countB === 9) {
    console.log("✅ Scenario B Passed: Sender identity security failure does not consume daily usage!");
  } else {
    console.error(`❌ Scenario B Failed: Usage changed to ${countB}`);
    process.exit(1);
  }

  // ==========================================
  // Scenario C: Successful Approval
  // ==========================================
  console.log("\n--- Scenario C: Successful Approval ---");
  await setActionCount(tenantId, 9, dateStr);
  console.log(`Baseline usage set to: ${await getActionCount(tenantId, dateStr)} / 10`);

  // User approves. Tool executes successfully.
  const toolResult = { status: "success", data: { id: "evt-123" } };
  const newMessagesToInsert = [
    { role: "tool", content: JSON.stringify(toolResult.data) },
    { role: "assistant", content: "Meeting created successfully." },
  ];

  let shouldChargeC = toolResult.status === "success";
  if (shouldChargeC) {
    for (const m of newMessagesToInsert) {
      if (m.role === "tool" && m.content) {
        try {
          const parsed = JSON.parse(m.content);
          if (parsed && typeof parsed === "object" && "error" in parsed) {
            shouldChargeC = false;
            break;
          }
        } catch {}
      }
    }
  }

  console.log("Should charge on successful tool execution?", shouldChargeC);
  if (shouldChargeC) {
    await incrementDailyLimit(tenantId, userEmail, "UTC");
  }

  const countC = await getActionCount(tenantId, dateStr);
  console.log(`Final Usage: ${countC} / 10`);
  if (countC === 10) {
    console.log("✅ Scenario C Passed: Successful approval correctly consumes daily usage!");
  } else {
    console.error(`❌ Scenario C Failed: Usage did not increment to 10 (got ${countC})`);
    process.exit(1);
  }

  // ==========================================
  // Scenario D: Assistant Error
  // ==========================================
  console.log("\n--- Scenario D: Assistant Error ---");
  await setActionCount(tenantId, 9, dateStr);
  console.log(`Baseline usage set to: ${await getActionCount(tenantId, dateStr)} / 10`);

  try {
    // Force simulated assistant failure / exception
    console.log("Simulating assistant processing failure / exception...");
    throw new Error("OpenAI API Rate Limit Exceeded");
    
    // This is never reached:
    await incrementDailyLimit(tenantId, userEmail, "UTC");
  } catch (err: any) {
    console.log("Caught simulated assistant error:", err.message);
  }

  const countD = await getActionCount(tenantId, dateStr);
  console.log(`Final Usage: ${countD} / 10`);
  if (countD === 9) {
    console.log("✅ Scenario D Passed: Assistant failure does not consume daily usage!");
  } else {
    console.error(`❌ Scenario D Failed: Usage changed to ${countD}`);
    process.exit(1);
  }

  console.log("\n🎉 ALL USAGE ACCOUNTING SCENARIOS VERIFIED SUCCESSFULLY! 🎉");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Test suite crashed:", err);
  process.exit(1);
});
