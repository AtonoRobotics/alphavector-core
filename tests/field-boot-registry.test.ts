import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { architectIssueFieldToken } from "../src/auth/architect-field-token.js";
import { CardBook } from "../src/auth/cards.js";
import { PackLoadError } from "../src/errors.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { FilePackRegistry } from "../src/packs/file-registry.js";
import { signPack } from "../src/packs/signing.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  loadReUnsigned,
  makeAnchors,
} from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const servers: FieldHttpServer[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.close();
  }
});

async function writeSignedRePack(dir: string) {
  const keys = makeAnchors();
  const binding = signPack(await loadReUnsigned(), keys.architectPrivate, keys.counselPrivate);
  const packPath = path.join(dir, "signed-pack.json");
  await writeFile(packPath, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
  return { keys, binding, packPath };
}

function productAnchorEnv(keys: ReturnType<typeof makeAnchors>, packPath?: string) {
  return {
    AV_ARCHITECT_PUBLIC_KEY: keys.anchors.architectPublicKeyPem,
    AV_COUNSEL_EVAL_PUBLIC_KEY: keys.anchors.counselEvalPublicKeyPem,
    ...(packPath ? { AV_PACK_PATH: packPath } : {}),
  };
}

describe("product boot from signed registry pack", () => {
  it("keeps the RE fixture pin at 5091328 and does not bake a boot default", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const bootSrc = readFileSync(path.join(REPO_ROOT, "src/http/field-boot.ts"), "utf8");
    expect(bootSrc).not.toMatch(/BUNDLED_PACK/);
    expect(bootSrc).not.toMatch(/fixtures\/packs\/alphavector-re/);
    expect(bootSrc).toMatch(/packs\.active/);
    expect(bootSrc).toMatch(/NO_ACTIVE_PACK/);
    const note = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(note).toContain(ALPHAVECTOR_RE_PIN_SHA);
    const pkg = readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
    expect(pkg).toMatch(/alphavector-re/);
    expect(pkg).not.toMatch(/VEYRA/);
    expect(bootSrc).not.toMatch(/VEYRA/);
    expect(bootSrc).not.toMatch(/\bT[0-3]\b/);
  });

  it("boot without a signed pack fails closed and does not load a fixture or mint a card", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-boot-no-pack-"));
    const keys = makeAnchors();
    const computerBaseDir = path.join(dir, "computer");
    const env = productAnchorEnv(keys);
    await expect(bootFieldCore("t1", { computerBaseDir, env })).rejects.toBeInstanceOf(PackLoadError);
    try {
      await bootFieldCore("t1", { computerBaseDir, env });
      throw new Error("expected boot without a signed pack to fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(PackLoadError);
      expect(["PACK_UNSIGNED", "PACK_INCOMPLETE"]).toContain((err as PackLoadError).code);
      expect((err as PackLoadError).closed).toBe(true);
    }
    expect(existsSync(path.join(computerBaseDir, "state", "packs", "t1.json"))).toBe(false);
    expect(new CardBook(computerBaseDir).fieldInbox("t1")).toEqual([]);
    await expect(bootFieldCore("t1", { env })).rejects.toMatchObject({
      name: "PackLoadError",
      code: "PACK_UNSIGNED",
    });
  });

  it("boot after the signed pin is loaded hydrates that pack from the registry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-boot-registry-hydrate-"));
    const { keys, packPath } = await writeSignedRePack(dir);
    const computerBaseDir = path.join(dir, "computer");
    const installed = await bootFieldCore("t1", {
      computerBaseDir,
      env: productAnchorEnv(keys, packPath),
    });
    expect(installed.pack.binding.identity.packId).toBe("alphavector-re");
    expect(installed.pack.binding.identity.displayName).toBe("AV Dev");

    const { pack, core, tenantId } = await bootFieldCore("t1", {
      computerBaseDir,
      env: productAnchorEnv(keys),
    });
    expect(pack.binding.identity.packId).toBe("alphavector-re");
    expect(pack.binding.identity.displayName).toBe("AV Dev");
    expect(pack.loadedBy).toBe("architect");
    expect(core.packs.active(tenantId).binding.identity.packId).toBe("alphavector-re");
    expect(core.agents.list(tenantId).length).toBeGreaterThan(0);
  });

  it("a tampered or unsigned fixture cannot become policy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-boot-unsigned-fixture-"));
    const keys = makeAnchors();
    const computerBaseDir = path.join(dir, "computer");
    const unsignedPath = path.join(REPO_ROOT, "fixtures/packs/alphavector-re/pack.json");
    await expect(
      bootFieldCore("t1", {
        computerBaseDir,
        env: productAnchorEnv(keys, unsignedPath),
      }),
    ).rejects.toBeInstanceOf(PackLoadError);
    try {
      await bootFieldCore("t1", {
        computerBaseDir,
        env: productAnchorEnv(keys, unsignedPath),
      });
      throw new Error("expected unsigned fixture inject to fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(PackLoadError);
      expect((err as PackLoadError).code).toBe("PACK_UNSIGNED");
      expect((err as PackLoadError).closed).toBe(true);
    }
    expect(existsSync(path.join(computerBaseDir, "state", "packs", "t1.json"))).toBe(false);
    expect(new CardBook(computerBaseDir).fieldInbox("t1")).toEqual([]);

    const signed = await writeSignedRePack(dir);
    const { tenantId } = await bootFieldCore("t1", {
      computerBaseDir,
      env: productAnchorEnv(signed.keys, signed.packPath),
    });
    const file = path.join(computerBaseDir, "state", "packs", `${tenantId}.json`);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as {
      binding: { identity: { displayName: string } };
    };
    onDisk.binding.identity.displayName = "mutated-after-load";
    await writeFile(file, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");

    await expect(
      bootFieldCore("t1", { computerBaseDir, env: productAnchorEnv(signed.keys) }),
    ).rejects.toBeInstanceOf(PackLoadError);
    try {
      await bootFieldCore("t1", { computerBaseDir, env: productAnchorEnv(signed.keys) });
      throw new Error("expected tampered registry pack to fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(PackLoadError);
      expect((err as PackLoadError).closed).toBe(true);
      expect(["PACK_UNSIGNED", "PACK_UNSIGNED_OWNER", "PACK_INCOMPLETE"]).toContain(
        (err as PackLoadError).code,
      );
    }
    const registry = new FilePackRegistry(path.join(computerBaseDir, "state"));
    expect(() => registry.getActive(tenantId, signed.keys.anchors)).toThrow(PackLoadError);
  });

  it("field still cannot configure models, prompts, Temporal, or tools after registry hydrate", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-boot-dec020-"));
    const { keys, packPath } = await writeSignedRePack(dir);
    const computerBaseDir = path.join(dir, "computer");
    await bootFieldCore("t1", {
      computerBaseDir,
      env: productAnchorEnv(keys, packPath),
    });
    const { core, pack, tenantId } = await bootFieldCore("t1", {
      computerBaseDir,
      env: productAnchorEnv(keys),
    });
    const architect = architectIssueFieldToken({
      tenantId,
      principal: "architect",
      computerBaseDir,
    });
    const issued = architectIssueFieldToken({
      tenantId,
      principal: "field",
      computerBaseDir,
      architectToken: architect.token,
    });
    const server = new FieldHttpServer({ core, pack, tenantId });
    servers.push(server);
    const listened = await server.listen(0, "127.0.0.1");
    const headers = { authorization: `Bearer ${issued.token}` };
    for (const route of ["/field/models", "/field/prompts", "/field/temporal", "/field/tools"]) {
      const res = await fetch(`${listened.url}${route}`, { headers });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("SURFACE_VIOLATION");
      expect(body.message).toMatch(/cannot configure models, prompts, Temporal, tools, or trust anchors/);
    }
    const serverSrc = readFileSync(path.join(REPO_ROOT, "src/http/field-server.ts"), "utf8");
    expect(serverSrc).toMatch(/Field user cannot configure models, prompts, Temporal, tools, or trust anchors/);
  });
});
