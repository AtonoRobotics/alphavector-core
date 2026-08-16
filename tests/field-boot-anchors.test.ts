import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PackLoadError, TrustAnchorError } from "../src/errors.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { startFieldServe } from "../src/http/field-listen.js";
import { FilePackRegistry } from "../src/packs/file-registry.js";
import { signPack } from "../src/packs/signing.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  loadReUnsigned,
  makeAnchors,
} from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";

async function writeSignedPack(dir: string) {
  const keys = makeAnchors();
  const binding = signPack(await loadReUnsigned(), keys.architectPrivate, keys.counselPrivate);
  const packPath = path.join(dir, "signed-pack.json");
  await writeFile(packPath, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
  return { keys, binding, packPath };
}

describe("product boot trust anchors DEC-019 / CS-093", () => {
  it("keeps the RE fixture pin at 5091328 and does not generate boot keys", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const bootSrc = readFileSync(path.join(REPO_ROOT, "src/http/field-boot.ts"), "utf8");
    expect(bootSrc).not.toMatch(/generateEd25519/);
    expect(bootSrc).not.toMatch(/signPack/);
    expect(bootSrc).not.toMatch(/generateKeyPairSync/);
    expect(bootSrc).not.toMatch(/BUNDLED_PACK/);
    expect(bootSrc).not.toMatch(/fixtures\/packs\/alphavector-re/);
    expect(bootSrc).toMatch(/resolveProductTrustAnchors/);
    expect(bootSrc).toMatch(/packs\.active/);
    const listenSrc = readFileSync(path.join(REPO_ROOT, "src/http/field-listen.ts"), "utf8");
    expect(listenSrc).not.toMatch(/generateEd25519|signPack|generateKeyPairSync/);
    expect(listenSrc).toMatch(/bootFieldCore\(tenantId, \{ computerBaseDir: opts\.computerBaseDir \}\)/);
    const note = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(note).toContain(ALPHAVECTOR_RE_PIN_SHA);
  });

  it("product boot with missing anchors fails closed and does not self-sign", async () => {
    await expect(bootFieldCore("t1", { env: {} })).rejects.toBeInstanceOf(TrustAnchorError);
    try {
      await bootFieldCore("t1", { env: {} });
      throw new Error("expected missing anchors to fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(TrustAnchorError);
      expect((err as TrustAnchorError).code).toBe("TRUST_ANCHORS_MISSING");
      expect((err as TrustAnchorError).closed).toBe(true);
    }
    await expect(
      bootFieldCore("t1", {
        env: { AV_ARCHITECT_PUBLIC_KEY: "  ", AV_COUNSEL_EVAL_PUBLIC_KEY: "  " },
      }),
    ).rejects.toMatchObject({ name: "TrustAnchorError", code: "TRUST_ANCHORS_MISSING" });
    await expect(
      bootFieldCore("t1", {
        env: { AV_ARCHITECT_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nonly-one\n-----END PUBLIC KEY-----" },
      }),
    ).rejects.toMatchObject({ name: "TrustAnchorError", code: "TRUST_ANCHORS_MISSING" });
  });

  it("startFieldServe with missing anchors fails closed", async () => {
    const prev = {
      AV_TRUST_ANCHORS_FILE: process.env.AV_TRUST_ANCHORS_FILE,
      AV_ARCHITECT_PUBLIC_KEY: process.env.AV_ARCHITECT_PUBLIC_KEY,
      AV_ARCHITECT_PUBLIC_KEY_FILE: process.env.AV_ARCHITECT_PUBLIC_KEY_FILE,
      AV_COUNSEL_EVAL_PUBLIC_KEY: process.env.AV_COUNSEL_EVAL_PUBLIC_KEY,
      AV_COUNSEL_EVAL_PUBLIC_KEY_FILE: process.env.AV_COUNSEL_EVAL_PUBLIC_KEY_FILE,
      AV_PACK_PATH: process.env.AV_PACK_PATH,
    };
    for (const key of Object.keys(prev)) delete process.env[key];
    try {
      await expect(startFieldServe({ tenantId: "t1", port: 0 })).rejects.toBeInstanceOf(TrustAnchorError);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("product boot with env public keys loads a pack signed by those keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-boot-env-anchors-"));
    const { keys, packPath } = await writeSignedPack(dir);
    const { pack } = await bootFieldCore("t1", {
      env: {
        AV_ARCHITECT_PUBLIC_KEY: keys.anchors.architectPublicKeyPem,
        AV_COUNSEL_EVAL_PUBLIC_KEY: keys.anchors.counselEvalPublicKeyPem,
        AV_PACK_PATH: packPath,
      },
    });
    expect(pack.binding.identity.packId).toBe("alphavector-re");
    expect(pack.loadedBy).toBe("architect");
  });

  it("product boot with trust-anchor files loads a pack signed by those keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-boot-file-anchors-"));
    const { keys, packPath } = await writeSignedPack(dir);
    const architectFile = path.join(dir, "architect.pem");
    const counselFile = path.join(dir, "counsel.pem");
    await writeFile(architectFile, keys.anchors.architectPublicKeyPem, "utf8");
    await writeFile(counselFile, keys.anchors.counselEvalPublicKeyPem, "utf8");
    const { pack } = await bootFieldCore("t1", {
      env: {
        AV_ARCHITECT_PUBLIC_KEY_FILE: architectFile,
        AV_COUNSEL_EVAL_PUBLIC_KEY_FILE: counselFile,
        AV_PACK_PATH: packPath,
      },
    });
    expect(pack.binding.identity.packId).toBe("alphavector-re");

    const anchorsFile = path.join(dir, "anchors.json");
    await writeFile(anchorsFile, `${JSON.stringify(keys.anchors, null, 2)}\n`, "utf8");
    const again = await bootFieldCore("t1", {
      env: {
        AV_TRUST_ANCHORS_FILE: anchorsFile,
        AV_PACK_PATH: packPath,
      },
    });
    expect(again.pack.binding.identity.packId).toBe("alphavector-re");
  });

  it("refuses a pack not signed by the configured anchors", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-boot-wrong-anchors-"));
    const signed = await writeSignedPack(dir);
    const other = makeAnchors();
    await expect(
      bootFieldCore("t1", {
        env: {
          AV_ARCHITECT_PUBLIC_KEY: other.anchors.architectPublicKeyPem,
          AV_COUNSEL_EVAL_PUBLIC_KEY: other.anchors.counselEvalPublicKeyPem,
          AV_PACK_PATH: signed.packPath,
        },
      }),
    ).rejects.toBeInstanceOf(PackLoadError);
    try {
      await bootFieldCore("t1", {
        env: {
          AV_ARCHITECT_PUBLIC_KEY: other.anchors.architectPublicKeyPem,
          AV_COUNSEL_EVAL_PUBLIC_KEY: other.anchors.counselEvalPublicKeyPem,
          AV_PACK_PATH: signed.packPath,
        },
      });
      throw new Error("expected unsigned-owner refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PackLoadError);
      expect((err as PackLoadError).code).toBe("PACK_UNSIGNED_OWNER");
      expect((err as PackLoadError).closed).toBe(true);
    }
  });

  it("C1 read-back verify still fails closed after on-disk mutation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-boot-readback-"));
    const { keys, packPath } = await writeSignedPack(dir);
    const computerBaseDir = path.join(dir, "computer");
    const { core, tenantId } = await bootFieldCore("t1", {
      computerBaseDir,
      env: {
        AV_ARCHITECT_PUBLIC_KEY: keys.anchors.architectPublicKeyPem,
        AV_COUNSEL_EVAL_PUBLIC_KEY: keys.anchors.counselEvalPublicKeyPem,
        AV_PACK_PATH: packPath,
      },
    });
    expect(core.packs.active(tenantId).binding.identity.packId).toBe("alphavector-re");

    const file = path.join(computerBaseDir, "state", "packs", `${tenantId}.json`);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as {
      binding: { identity: { displayName: string } };
    };
    onDisk.binding.identity.displayName = "mutated-after-load";
    await writeFile(file, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");

    const registry = new FilePackRegistry(path.join(computerBaseDir, "state"));
    expect(() => registry.getActive(tenantId, keys.anchors)).toThrow(PackLoadError);
    expect(() => registry.getActive(tenantId, keys.anchors)).toThrow(/Architect signature invalid/);
    expect(() => core.packs.active(tenantId)).toThrow(PackLoadError);
    try {
      core.packs.active(tenantId);
      throw new Error("expected active() to refuse the mutated record");
    } catch (err) {
      expect(err).toBeInstanceOf(PackLoadError);
      expect((err as PackLoadError).code).toBe("PACK_UNSIGNED_OWNER");
    }
  });
});
