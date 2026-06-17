import { corsair } from "@repo/corsair";

async function main() {
  const tenantId = "I18zlIaeuH86k4fZhzGM0B0BPgMaGGMw";
  const tenant = corsair.withTenant(tenantId);

  try {
    console.log("googlecalendar keys:", Object.keys(tenant.googlecalendar));
    console.log("googlecalendar api keys:", Object.keys(tenant.googlecalendar.api));
    if ((tenant.googlecalendar.api as any).events) {
      console.log("googlecalendar api.events keys:", Object.keys((tenant.googlecalendar.api as any).events));
    }
  } catch (error) {
    console.error("Error inspecting calendar api:", error);
  }
  process.exit(0);
}

main();
