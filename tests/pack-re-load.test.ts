import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_SCHEMA_SQL } from "../src/data/sql.js";
import { FilePackRegistry } from "../src/packs/file-registry.js";
import { MemoryPackRegistry, PackLoader } from "../src/packs/loader.js";
import { signPack } from "../src/packs/signing.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  loadReUnsigned,
  makeAnchors,
  REPO_ROOT,
  signedRePack,
} from "./helpers.js";

describe("alphavector-re pack load (pinned first slice)", () => {
  it("records the RE pin SHA next to the vendored fixture", async () => {
    const note = await readFile(
      path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"),
      "utf8",
    );
    expect(note).toContain(ALPHAVECTOR_RE_PIN_SHA);
    expect(note).toContain("fixtures/packs/re/pack.json");
  });

  it("refuses the unsigned RE fixture", async () => {
    const { anchors } = await signedRePack();
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const unsigned = await loadReUnsigned();
    const result = loader.load({ tenantId: "t1", binding: unsigned, actor: "architect" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PACK_UNSIGNED");
  });

  it("refuses field-user load of the signed RE fixture", async () => {
    const { anchors, binding } = await signedRePack();
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const result = loader.load({ tenantId: "t1", binding, actor: "field" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FIELD_CANNOT_LOAD_PACK");
  });

  it("loads the signed RE fixture as architect with packId alphavector-re", async () => {
    const unsigned = await loadReUnsigned();
    const keys = makeAnchors();
    const binding = signPack(unsigned, keys.architectPrivate, keys.counselPrivate);
    const loader = new PackLoader(new MemoryPackRegistry(), keys.anchors);
    const result = loader.load({ tenantId: "t1", binding, actor: "architect" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loaded.binding.identity.packId).toBe("alphavector-re");
      expect(result.loaded.binding.identity.displayName).toBe("AV Dev");
    }
  });

  it("FilePackRegistry persists and reloads the signed RE fixture", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-re-packs-"));
    const { anchors, binding } = await signedRePack();
    const first = new PackLoader(new FilePackRegistry(dir), anchors);
    const loaded = first.load({ tenantId: "t1", binding, actor: "architect" });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.loaded.binding.identity.packId).toBe("alphavector-re");
    }

    const second = new PackLoader(new FilePackRegistry(dir), anchors);
    const active = second.active("t1");
    expect(active.binding.identity.packId).toBe("alphavector-re");
    expect(active.binding.identity.displayName).toBe("AV Dev");
    expect(active.binding.roles).toHaveLength(binding.roles.length);
  });

  it("binds written REQUIRES PREFERS AVOIDS on generic slots; authored journeys stay id/label", async () => {
    const unsigned = await loadReUnsigned();
    expect(unsigned.recordPartyKnowledge.predicates).toEqual(
      expect.arrayContaining(["REQUIRES", "PREFERS", "AVOIDS"]),
    );
    expect(unsigned.recordPartyKnowledge.graphEdgeKinds).toEqual(
      expect.arrayContaining(["REQUIRES", "PREFERS", "AVOIDS"]),
    );
    for (const journey of unsigned.journeyKinds) {
      expect(Object.keys(journey).sort()).toEqual(["id", "label"]);
    }
  });

  it("keeps Person/Household/Listing as pack kinds, not core schema columns", async () => {
    const unsigned = await loadReUnsigned();
    expect(unsigned.recordPartyKnowledge.partyKinds).toEqual(
      expect.arrayContaining(["Person", "Household"]),
    );
    expect(unsigned.recordPartyKnowledge.recordKinds).toEqual(
      expect.arrayContaining(["Listing"]),
    );

    const migrationFiles = await readdir(path.join(REPO_ROOT, "migrations"));
    const migrationSql = (
      await Promise.all(
        migrationFiles
          .filter((name) => name.endsWith(".sql"))
          .map((name) => readFile(path.join(REPO_ROOT, "migrations", name), "utf8")),
      )
    ).join("\n");
    const schemaAndMigrations = `${CORE_SCHEMA_SQL}\n${migrationSql}`;
    expect(schemaAndMigrations).not.toMatch(/listing_id|person_id|household_id/i);
  });
});
