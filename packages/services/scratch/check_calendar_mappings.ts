import { db, desc, eq, asc } from "../../database/index.ts";
import { calendarTenantMappings } from "../../database/models/calendar-tenant-mappings.ts";
import { corsairConnectionEmails } from "../../database/models/corsair-connections.ts";

async function main() {
  console.log("=== Auditing Calendar Connections & Mappings ===");
  
  const connections = await db.select().from(corsairConnectionEmails);
  console.log("\n1. Corsair Connection Emails in DB:");
  console.log(JSON.stringify(connections, null, 2));

  const mappings = await db.select().from(calendarTenantMappings);
  console.log("\n2. Google Calendar Watch Mappings in DB:");
  console.log(JSON.stringify(mappings, null, 2));

  process.exit(0);
}

main().catch(console.error);
