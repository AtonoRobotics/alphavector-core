#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PRODUCT } from "./identity.js";
import { AlphaVectorCore } from "./kernel.js";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`${PRODUCT.appDisplay} (${PRODUCT.package})`);
    console.log("Commands: identity | pack-check <file> | computer-start <tenant>");
    return;
  }
  if (cmd === "identity") {
    console.log(JSON.stringify(PRODUCT, null, 2));
    return;
  }
  if (cmd === "pack-check") {
    const file = rest[0];
    if (!file) throw new Error("pack-check requires a file");
    const raw = JSON.parse(await readFile(file, "utf8"));
    const { assertCompletePack } = await import("./packs/schema.js");
    assertCompletePack(raw);
    console.log("pack sections complete");
    return;
  }
  if (cmd === "computer-start") {
    const tenant = rest[0] ?? "dev";
    const cwd = process.cwd();
    const core = await AlphaVectorCore.boot({
      computer: {
        baseDir: path.join(cwd, ".av-computers"),
        imageCacheDir: path.join(cwd, "images"),
      },
      anchors: {
        architectPublicKeyPem: "unused",
        counselEvalPublicKeyPem: "unused",
      },
    });
    const computer = await core.computer.start(tenant);
    console.log(JSON.stringify(computer, null, 2));
    return;
  }
  throw new Error(`Unknown command ${cmd}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
