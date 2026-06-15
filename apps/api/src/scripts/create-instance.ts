import { corsairClient } from "@repo/corsair";

async function main() {
  const instance = await corsairClient.instances.create({
    name: "mailroid",
  });

  console.log(instance);
}

main();
