import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PackLoadError } from "../src/errors.js";
import { FilePackRegistry } from "../src/packs/file-registry.js";
import { MemoryPackRegistry, PackLoader } from "../src/packs/loader.js";
import { signPack } from "../src/packs/signing.js";
import { loadGenericUnsigned, makeAnchors, signedGenericPack, signedGenericPackMutated } from "./helpers.js";

describe("pack load DEC-019", () => {
  it("refuses an unsigned pack", async () => {
    const { anchors } = await signedGenericPack();
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const unsigned = await loadGenericUnsigned();
    const result = loader.load({ tenantId: "t1", binding: unsigned, actor: "architect" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PACK_UNSIGNED");
  });

  it("refuses a pack signed only by architect", async () => {
    const keys = makeAnchors();
    const unsigned = await loadGenericUnsigned();
    const half = signPack(unsigned, keys.architectPrivate, keys.counselPrivate);
    half.signatures = { architect: half.signatures!.architect, counselEval: "" };
    const loader = new PackLoader(new MemoryPackRegistry(), keys.anchors);
    const result = loader.load({ tenantId: "t1", binding: half, actor: "architect" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PACK_UNSIGNED_OWNER");
  });

  it("refuses an incomplete pack", async () => {
    const { anchors, binding } = await signedGenericPack();
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const { roles: _r, ...incomplete } = binding;
    const result = loader.load({ tenantId: "t1", binding: incomplete, actor: "architect" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PACK_INCOMPLETE");
  });

  it("refuses field-user load", async () => {
    const { anchors, binding } = await signedGenericPack();
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const result = loader.load({ tenantId: "t1", binding, actor: "field" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FIELD_CANNOT_LOAD_PACK");
  });

  it("loads a signed generic fixture pack", async () => {
    const { anchors, binding } = await signedGenericPack();
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const result = loader.load({ tenantId: "t1", binding, actor: "architect" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loaded.binding.identity.packId).toBe("av-fixture-generic");
      expect(result.loaded.binding.roles).toHaveLength(4);
    }
  });

  it("generic fixture has no Real Estate or Mission Control types", async () => {
    const unsigned = await loadGenericUnsigned();
    const kinds = [
      ...unsigned.recordPartyKnowledge.partyKinds,
      ...unsigned.recordPartyKnowledge.recordKinds,
      ...unsigned.recordPartyKnowledge.graphNodeKinds,
      ...unsigned.journeyKinds.map((j) => j.id),
      ...unsigned.roles.map((r) => r.name),
    ].map((s) => s.toLowerCase());
    for (const word of [
      "listing",
      "household",
      "person",
      "buyer",
      "seller",
      "showing",
      "mls",
      "desk",
      "shape",
      "director",
      "play",
      "plant",
      "hil",
      "thor",
    ]) {
      expect(kinds).not.toContain(word);
    }
  });

  it("loads a pack without an adapter section", async () => {
    const { anchors, binding } = await signedGenericPack();
    expect(binding.adapter).toBeUndefined();
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const result = loader.load({ tenantId: "t1", binding, actor: "architect" });
    expect(result.ok).toBe(true);
  });

  it("loads a pack with an optional adapter allow-list and default model id", async () => {
    const { anchors, binding } = await signedGenericPackMutated((unsigned) => {
      unsigned.adapter = { allowList: ["ci-double"], defaultModelId: "ci-double" };
    });
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const result = loader.load({ tenantId: "t1", binding, actor: "architect" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loaded.binding.adapter?.allowList).toEqual(["ci-double"]);
      expect(result.loaded.binding.adapter?.defaultModelId).toBe("ci-double");
    }
  });

  it("refuses a pack adapter declaration that carries credentials", async () => {
    const { anchors } = makeAnchors();
    const unsigned = await loadGenericUnsigned();
    const poisoned = {
      ...unsigned,
      adapter: { defaultModelId: "ci-double", apiKey: "sk-secret" },
    };
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const result = loader.load({ tenantId: "t1", binding: poisoned, actor: "architect" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PACK_INVALID");
  });

  it("rejects invented T0-T3 numbers on action-class verbs", async () => {
    const { anchors } = makeAnchors();
    const unsigned = await loadGenericUnsigned();
    const poisoned = {
      ...unsigned,
      actionClassVerbs: unsigned.actionClassVerbs.map((v) => ({ ...v, tier: "T0" })),
    };
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const result = loader.load({ tenantId: "t1", binding: poisoned, actor: "architect" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PACK_INVALID");
  });
});

describe("pack read-back DEC-019", () => {
  it("getActive and active refuse a disk record whose signature no longer matches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-pack-readback-"));
    const { anchors, binding } = await signedGenericPack();
    const registry = new FilePackRegistry(dir);
    const loader = new PackLoader(registry, anchors);
    const loaded = loader.load({ tenantId: "t1", binding, actor: "architect" });
    expect(loaded.ok).toBe(true);
    expect(loader.active("t1").binding.identity.packId).toBe("av-fixture-generic");

    const file = path.join(dir, "packs", "t1.json");
    const onDisk = JSON.parse(await readFile(file, "utf8")) as {
      binding: { identity: { displayName: string } };
    };
    onDisk.binding.identity.displayName = "mutated-after-load";
    await writeFile(file, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");

    expect(() => registry.getActive("t1", anchors)).toThrow(PackLoadError);
    expect(() => registry.getActive("t1", anchors)).toThrow(/Architect signature invalid/);
    expect(() => loader.active("t1")).toThrow(PackLoadError);
    try {
      loader.active("t1");
      throw new Error("expected active() to refuse the mutated record");
    } catch (err) {
      expect(err).toBeInstanceOf(PackLoadError);
      expect((err as PackLoadError).code).toBe("PACK_UNSIGNED_OWNER");
    }
  });

  it("read-back refuses an unsigned on-disk record", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-pack-unsigned-readback-"));
    const { anchors, binding } = await signedGenericPack();
    const registry = new FilePackRegistry(dir);
    const loader = new PackLoader(registry, anchors);
    expect(loader.load({ tenantId: "t1", binding, actor: "architect" }).ok).toBe(true);

    const file = path.join(dir, "packs", "t1.json");
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { binding: { signatures?: unknown } };
    delete onDisk.binding.signatures;
    await writeFile(file, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");

    expect(() => loader.active("t1")).toThrow(PackLoadError);
    try {
      registry.getActive("t1", anchors);
      throw new Error("expected getActive to refuse an unsigned record");
    } catch (err) {
      expect(err).toBeInstanceOf(PackLoadError);
      expect((err as PackLoadError).code).toBe("PACK_UNSIGNED");
    }
  });

  it("read-back refuses an incomplete on-disk record", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-pack-incomplete-readback-"));
    const { anchors, binding } = await signedGenericPack();
    const registry = new FilePackRegistry(dir);
    const loader = new PackLoader(registry, anchors);
    expect(loader.load({ tenantId: "t1", binding, actor: "architect" }).ok).toBe(true);

    const file = path.join(dir, "packs", "t1.json");
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { binding: Record<string, unknown> };
    delete onDisk.binding.roles;
    await writeFile(file, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");

    expect(() => loader.active("t1")).toThrow(PackLoadError);
    try {
      registry.getActive("t1", anchors);
      throw new Error("expected getActive to refuse an incomplete record");
    } catch (err) {
      expect(err).toBeInstanceOf(PackLoadError);
      expect((err as PackLoadError).code).toBe("PACK_INCOMPLETE");
    }
  });
});
