#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { architectIssueFieldToken, architectRevokeFieldToken } from "./auth/architect-field-token.js";
import { FieldClient } from "./http/field-client.js";
import { startFieldServe } from "./http/field-listen.js";
import { PRODUCT } from "./identity.js";
import { AlphaVectorCore } from "./kernel.js";
import type { PrincipalKind } from "./packs/types.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function computerBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AV_COMPUTER_DIR ?? path.join(process.cwd(), ".av-computers");
}

function tenantIdOf(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return flag(args, "--tenant") ?? env.AV_TENANT ?? "t1";
}

function asPrincipal(value: string | undefined): PrincipalKind {
  if (!value || value === "field" || value === "architect" || value === "counsel_eval") {
    return (value ?? "field") as PrincipalKind;
  }
  throw new Error("principal must be field, architect, or counsel_eval");
}

function architectTokenOf(args: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  return flag(args, "--architect-token") ?? env.AV_ARCHITECT_TOKEN;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`${PRODUCT.appDisplay} (${PRODUCT.package})`);
    console.log(
      "Commands: identity | pack-check <file> | computer-start <tenant> | architect | field-serve | field-client",
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
  if (cmd === "architect") {
    const [sub, ...flags] = rest;
    if (!sub || sub === "help" || sub === "--help") {
      console.log("Architect (off the field home screen). Commands: issue-field-token | revoke-field-token");
      console.log("Present --architect-token or AV_ARCHITECT_TOKEN. Shell is not Architect.");
      console.log("First Architect credential: issue-field-token --principal architect (once).");
      return;
    }
    const dir = computerBaseDir();
    const tenantId = tenantIdOf(flags);
    const architectToken = architectTokenOf(flags);
    if (sub === "issue-field-token") {
      const issued = architectIssueFieldToken({
        tenantId,
        principal: asPrincipal(flag(flags, "--principal")),
        computerBaseDir: dir,
        architectToken,
      });
      console.log(JSON.stringify(issued, null, 2));
      console.log("Present this token to field-serve. Serve does not issue tokens. Secret is shown once.");
      return;
    }
    if (sub === "revoke-field-token") {
      const tokenId = flag(flags, "--token-id");
      if (!tokenId) throw new Error("architect revoke-field-token requires --token-id");
      architectRevokeFieldToken({ tenantId, tokenId, computerBaseDir: dir, architectToken });
      console.log(JSON.stringify({ ok: true, tenantId, tokenId }, null, 2));
      return;
    }
    throw new Error("architect commands: issue-field-token | revoke-field-token");
  }
  if (cmd === "field-serve") {
    const port = Number(flag(rest, "--port") ?? process.env.AV_FIELD_PORT ?? 8787);
    const { url } = await startFieldServe({
      tenantId: tenantIdOf(rest),
      computerBaseDir: computerBaseDir(),
      port: Number.isFinite(port) ? port : 8787,
      host: "127.0.0.1",
    });
    console.log(`${PRODUCT.appDisplay} field surface`);
    console.log(`open ${url}`);
    console.log("Present a field token Architect issued (Authorization, --token, or AV_FIELD_TOKEN). Serve does not issue tokens.");
    console.log("Architect/admin is not callable on /field. Field cannot configure models, prompts, Temporal, or tools.");
    return;
  }
  if (cmd === "field-client") {
    const base = flag(rest, "--base") ?? process.env.AV_FIELD_URL ?? "http://127.0.0.1:8787";
    const token = flag(rest, "--token") ?? process.env.AV_FIELD_TOKEN ?? "";
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
