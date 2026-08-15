import { assertArchitect, assertSameTenant } from "../principals/guard.js";
import type { Principal } from "../principals/types.js";
import { packPayloadBytes, verifyPackSignatures } from "./signature.js";
import { missingRequiredSections, packDocumentSchema } from "./schema.js";
import { PackLoadError } from "./errors.js";
import type { LoadedPack, PackDocument } from "./types.js";
import type { PackStore } from "./store.js";

export interface PackLoadRequest {
  tenantId: string;
  principal: Principal;
  document: unknown;
}

/**
 * DEC-019: signed binding. Unsigned / incomplete / unsigned-owner fails closed.
 * One active pack per tenant. Field user cannot load or edit a pack.
 */
export class PackLoader {
  constructor(private readonly store: PackStore) {}

  async load(request: PackLoadRequest): Promise<LoadedPack> {
    assertSameTenant(request.principal, request.tenantId);
    assertArchitect(request.principal, "load or edit a pack");

    if (request.document === null || typeof request.document !== "object") {
      throw new PackLoadError("PACK_INCOMPLETE", "Pack document is missing.");
    }

    const missing = missingRequiredSections(request.document);
    if (missing.length > 0) {
      throw new PackLoadError(
        "PACK_INCOMPLETE",
        `Pack is incomplete. Missing required sections: ${missing.join(", ")}.`,
      );
    }

    const signatures = (request.document as { signatures?: { pack?: { signature?: string }; owner?: { signature?: string } } })
      .signatures;
    if (!signatures || typeof signatures !== "object" || !signatures.pack?.signature) {
      throw new PackLoadError("PACK_UNSIGNED", "Unsigned pack refused.");
    }
    if (!signatures.owner?.signature) {
      throw new PackLoadError("PACK_OWNER_UNSIGNED", "Owner signature is missing.");
    }

    const parsed = packDocumentSchema.safeParse(request.document);
    if (!parsed.success) {
      throw new PackLoadError("PACK_INCOMPLETE", `Pack failed schema validation: ${parsed.error.message}`);
    }

    const document: PackDocument = parsed.data;
    verifyPackSignatures(document);

    const loaded: LoadedPack = {
      tenantId: request.tenantId,
      document,
      canonicalBytes: packPayloadBytes(document),
      loadedBy: request.principal.id,
      loadedAt: new Date(),
    };

    await this.store.activate(loaded);
    return loaded;
  }

  async active(tenantId: string): Promise<LoadedPack> {
    const pack = await this.store.getActive(tenantId);
    if (!pack) {
      throw new PackLoadError("PACK_NONE_ACTIVE", "Tenant has no active pack. Fail closed.");
    }
    return pack;
  }
}
