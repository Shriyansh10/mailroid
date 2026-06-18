import { corsair } from "@repo/corsair";

async function main() {
  const tenantId = "I18zlIaeuH86k4fZhzGM0B0BPgMaGGMw";
  const tenant = corsair.withTenant(tenantId);

  try {
    console.log("googlecalendar keys:", Object.keys(tenant.googlecalendar));
    console.log("googlecalendar api keys:", Object.keys(tenant.googlecalendar.api));
    const response = await tenant.googlecalendar.api.events.getMany({ maxResults: 10 });
    console.log("getMany response keys:", Object.keys(response));
    console.log("getMany response timeZone:", (response as any).timeZone);
    if (response.items && response.items.length > 0) {
      console.log("First event start keys:", Object.keys(response.items[0].start || {}));
      console.log("First event start timeZone:", response.items[0].start?.timeZone);
    }
  } catch (error) {
    console.error("Error inspecting calendar api:", error);
  }
  process.exit(0);
}

main();
