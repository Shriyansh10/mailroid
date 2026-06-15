import { corsairClient } from "@repo/corsair";

async function main() {
  const inst = corsairClient.instance(
    process.env.CORSAIR_INSTANCE_ID!,
  );

  await inst.plugins.upsert("gmail");
  await inst.plugins.upsert("googlecalendar");
  

  console.log(inst);
}

main();
