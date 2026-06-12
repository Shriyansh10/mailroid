import {corsairClient} from "@repo/corsair";

async function main() {
    try {
        const instance = await corsairClient.instances.create({
        name: "mailroid",
    });

        console.log("Created:", instance);
    } catch (error) {
        console.error(error);
    }
}

main();
