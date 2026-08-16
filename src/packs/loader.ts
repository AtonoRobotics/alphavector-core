import { PackLoadError } from "../errors.js";
import { nowIso } from "../ids.js";
import { evaluateAdversarialFixtures } from "../policy/evaluator.js";
import { assertCompletePack } from "./schema.js";
import { assertVerifiedLoadedPack, verifyPackSignatures, type TrustAnchors } from "./signing.js";
import type { LoadedPack, PackBinding, PackLoadResult, PrincipalKind } from "./types.js";

export interface PackRegistry {
  getActive(tenantId: string, anchors: TrustAnchors): LoadedPack | undefined;
  setActive(loaded: LoadedPack): void;
}

export class MemoryPackRegistry implements PackRegistry {
  private readonly active = new Map<string, LoadedPack>();

  getActive(tenantId: string, anchors: TrustAnchors): LoadedPack | undefined {
    const loaded = this.active.get(tenantId);
    if (!loaded) return undefined;
    return assertVerifiedLoadedPack(loaded, anchors, tenantId);
  }

  setActive(loaded: LoadedPack): void {
    this.active.set(loaded.tenantId, loaded);
  }
}

export class PackLoader {
  constructor(
    private readonly registry: PackRegistry,
    private readonly anchors: TrustAnchors,
  ) {}

  /** Trust anchors this loader re-verifies against. Product deploy uses these. */
  trustAnchors(): TrustAnchors {
    return this.anchors;
  }

  load(input: {
    tenantId: string;
    binding: unknown;
    actor: PrincipalKind;
  }): PackLoadResult {
    try {
      if (input.actor === "field") {
        throw new PackLoadError("FIELD_CANNOT_LOAD_PACK", "Field user cannot load or edit a pack");
      }
      if (input.actor !== "architect") {
        throw new PackLoadError("PACK_UNSIGNED_OWNER", "Only Architect plus counsel/eval may load a pack");
      }

      const binding = assertCompletePack(input.binding);
      verifyPackSignatures(binding, this.anchors);
      this.assertFixturesPass(binding);

      const loaded: LoadedPack = {
        tenantId: input.tenantId,
        binding,
        loadedAt: nowIso(),
        loadedBy: "architect",
      };
      this.registry.setActive(loaded);
      return { ok: true, loaded };
    } catch (err) {
      if (err instanceof PackLoadError) {
        return { ok: false, code: err.code, message: err.message };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "PACK_REFUSED", message };
    }
  }

  active(tenantId: string): LoadedPack {
    const loaded = this.registry.getActive(tenantId, this.anchors);
    if (!loaded) {
      throw new PackLoadError("NO_ACTIVE_PACK", `No active pack binding for tenant ${tenantId}`);
    }
    return assertVerifiedLoadedPack(loaded, this.anchors, tenantId);
  }

  private assertFixturesPass(binding: PackBinding): void {
    const result = evaluateAdversarialFixtures(binding.policy);
    if (!result.ok) {
      throw new PackLoadError("PACK_FIXTURES_FAILED", result.message);
    }
    if (!binding.evidenceEvalFixtures.some((f) => f.countsAsIndependentOutcome)) {
      throw new PackLoadError(
        "PACK_FIXTURES_FAILED",
        "evidenceEvalFixtures must include at least one independent-outcome fixture",
      );
    }
  }
}
