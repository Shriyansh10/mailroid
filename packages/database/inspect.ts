import { db } from "./index.ts";
import { messageMetadata } from "./models/message-metadata.ts";

async function main() {
  const records = await db.select().from(messageMetadata).limit(20);
  console.log("METADATA RECORDS:");
  for (const r of records) {
    console.log(`id: ${r.entityId}, priority: ${r.priority}, score: ${r.priorityScore}, type: ${typeof r.priorityScore}`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
