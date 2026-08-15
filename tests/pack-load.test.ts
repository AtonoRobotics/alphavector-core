import { describe, expect, it } from "vitest";
import { unsignedGenericPack } from "../src/fixtures/generic-pack.js";
import { PackLoadError } from "../src/pack/errors.js";
import { PackLoader } from "../src/pack/loader.js";
import { generateEd25519KeyPair, signPackDocument } from "../src/pack/signature.js";
import { MemoryPackStore } from "../src/pack/store.js";
import { loadSignedFixture, principals, unsignedPack } from "./helpers.js";

describe("pack load fail-closed", () => {
  it("refuses an unsigned pack", async () => {
    const tenantId = "tenant_unsigned";
    const loader = new PackLoader(new MemoryPackStore());
    await expect(
      loader.load({ tenantId, principal: principals(tenantId).architect, document: unsignedPack() }),
    ).rejects.toMatchObject({ code: "PACK_UNSIGNED" });
  });

  it("refuses an incomplete pack", async () => {
    const tenantId = "tenant_incomplete";
    const loader = new PackLoader(new MemoryPackStore());
    await expect(
      loader.load({
        tenantId,
        principal: principals(tenantId).architect,
        document: { identity: { packId: "x" } },
      }),
    ).rejects.toMatchObject({ code: "PACK_INCOMPLETE" });
  });

  it("refuses a pack with no owner signature", async () => {
    const tenantId = "tenant_owner";
    const keys = { pack: generateEd25519KeyPair(), owner: generateEd25519KeyPair() };
    const signed = signPackDocument(unsignedGenericPack(), keys.pack, keys.owner);
    signed.signatures.owner.signature = "";
    const loader = new PackLoader(new MemoryPackStore());
    await expect(
      loader.load({ tenantId, principal: principals(tenantId).architect, document: signed }),
    ).rejects.toBeInstanceOf(PackLoadError);
  });

  it("refuses a pack whose owner signature does not verify", async () => {
    const tenantId = "tenant_bad_owner";
    const keys = { pack: generateEd25519KeyPair(), owner: generateEd25519KeyPair() };
    const signed = signPackDocument(unsignedGenericPack(), keys.pack, keys.owner);
    signed.signatures.owner.signature = keys.pack.publicKey;
    const loader = new PackLoader(new MemoryPackStore());
    await expect(
      loader.load({ tenantId, principal: principals(tenantId).architect, document: signed }),
    ).rejects.toMatchObject({ code: "PACK_OWNER_UNSIGNED" });
  });

  it("loads a complete signed generic fixture pack", async () => {
    const { loaded } = await loadSignedFixture(4);
    expect(loaded.document.identity.domain).toBe("generic-operations");
    expect(loaded.document.identity.packId).toContain("fixture.generic");
    expect(loaded.document.orgChart.seats).toHaveLength(4);
    expect(loaded.document.policy.defaultStance).toBe("authorization");
  });

  it("keeps one active pack per tenant", async () => {
    const first = await loadSignedFixture(4);
    const next = unsignedGenericPack(4);
    next.identity.version = "1.0.1";
    const resigned = signPackDocument(next, first.keys.pack, first.keys.owner);
    const again = await first.loader.load({
      tenantId: first.tenantId,
      principal: first.people.architect,
      document: resigned,
    });
    const active = await first.loader.active(first.tenantId);
    expect(active.document.identity.version).toBe("1.0.1");
    expect(again.tenantId).toBe(first.tenantId);
  });

  it("refuses field users who try to load a pack", async () => {
    const tenantId = "tenant_field_pack";
    const loader = new PackLoader(new MemoryPackStore());
    await expect(
      loader.load({ tenantId, principal: principals(tenantId).field, document: unsignedPack() }),
    ).rejects.toMatchObject({ code: "ARCHITECT_ONLY" });
  });

  it("fixture pack contains no Real Estate or Mission Control types", async () => {
    const { loaded } = await loadSignedFixture();
    const blob = JSON.stringify(loaded.document).toLowerCase();
    for (const banned of [
      /\blisting\b/,
      /\bhousehold\b/,
      /real estate/,
      /mission control/,
      /\bguido\b/,
      /\bfido\b/,
      /\buplink\b/,
      /\bthor\b/,
      /\bnexus\b/,
      /\bdesk\b/,
      /\bhil\b/,
    ]) {
      expect(blob).not.toMatch(banned);
    }
  });
});
