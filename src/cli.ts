#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FieldClient } from "./http/field-client.js";
import { bootFieldCore } from "./http/field-boot.js";
import { FieldHttpServer } from "./http/field-server.js";
import { PRODUCT } from "./identity.js";
import { AlphaVectorCore } from "./kernel.js";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`${PRODUCT.appDisplay} (${PRODUCT.package})`);
    console.log(
      "Commands: identity | pack-check <file> | computer-start <tenant> | field-serve | field-client",
    );
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
  if (cmd === "field-serve") {
    const portFlag = rest.indexOf("--port");
    const port = portFlag >= 0 ? Number(rest[portFlag + 1]) : Number(process.env.AV_FIELD_PORT ?? 8787);
    const { core, pack, tenantId } = await bootFieldCore(process.env.AV_TENANT ?? "t1");
    const tokens = {
      field: process.env.AV_FIELD_TOKEN ?? `field-${randomBytes(8).toString("hex")}`,
      architect: process.env.AV_ARCHITECT_TOKEN ?? `architect-${randomBytes(8).toString("hex")}`,
    };
    const server = new FieldHttpServer({ core, pack, tenantId, tokens });
    const { url } = await server.listen(Number.isFinite(port) ? port : 8787, "127.0.0.1");
    console.log(`${PRODUCT.appDisplay} field surface`);
    console.log(`open ${url}`);
    console.log(`field token: ${tokens.field}`);
    console.log("Architect/admin is not callable on /field. Field cannot configure models, prompts, Temporal, or tools.");
    return;
  }
  if (cmd === "field-client") {
    const baseFlag = rest.indexOf("--base");
    const tokenFlag = rest.indexOf("--token");
    const base = (baseFlag >= 0 ? rest[baseFlag + 1] : process.env.AV_FIELD_URL) ?? "http://127.0.0.1:8787";
    const token = (tokenFlag >= 0 ? rest[tokenFlag + 1] : process.env.AV_FIELD_TOKEN) ?? "";
    if (!token) throw new Error("field-client requires --token or AV_FIELD_TOKEN");
    const client = new FieldClient(base, token);
    if (rest.includes("--complete-demo")) {
      const done = await client.completeBuyerJourneyAndCard();
      console.log(JSON.stringify({ ok: true, ...done }, null, 2));
      return;
    }
    const home = await client.home();
    console.log(JSON.stringify(home, null, 2));
    return;
  }
  throw new Error(`Unknown command ${cmd}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
