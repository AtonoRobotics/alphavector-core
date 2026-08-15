import { writeFile } from "node:fs/promises";
import { signedGenericPack } from "../src/fixtures/generic-pack.js";
import { generateEd25519KeyPair } from "../src/pack/signature.js";

const packKey = generateEd25519KeyPair();
const ownerKey = generateEd25519KeyPair();
const document = signedGenericPack(packKey, ownerKey, 4);
await writeFile("fixtures/packs/generic.pack.json", `${JSON.stringify(document, null, 2)}\n`);
await writeFile("fixtures/keys/pack.ed25519.json", `${JSON.stringify(packKey, null, 2)}\n`);
await writeFile("fixtures/keys/owner.ed25519.json", `${JSON.stringify(ownerKey, null, 2)}\n`);
console.log("signed generic fixture pack");
