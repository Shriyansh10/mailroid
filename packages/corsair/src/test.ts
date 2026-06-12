import 'dotenv/config';
import { corsair } from "./index";

const main = async () => {
    const res = await corsair.withTenant('xyz')
    console.log(res)
}


main();
