import path from "node:path";
import { PackLoadError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import type { PackRegistry } from "./loader.js";
import { assertVerifiedLoadedPack, type TrustAnchors } from "./signing.js";
import type { LoadedPack } from "./types.js";

/**
 * Durable pack registry. One active pack per tenant, persisted on disk.
 * Every getActive re-verifies signatures against the supplied trust anchors (DEC-019).
 * MemoryPackRegistry remains for unit tests that do not need process restart.
 */
export class FilePackRegistry implements PackRegistry {
  constructor(private readonly stateDir: string) {}

  getActive(tenantId: string, anchors: TrustAnchors): LoadedPack | undefined {
    let raw: unknown;
    try {
      raw = readJsonFileStrict<unknown>(this.fileFor(tenantId));
    } catch {
      throw new PackLoadError("PACK_REFUSED", "Active pack record is unreadable");
    }
    if (raw === undefined) return undefined;
    return assertVerifiedLoadedPack(raw, anchors, tenantId);
  }

  setActive(loaded: LoadedPack): void {
    writeJsonAtomic(this.fileFor(loaded.tenantId), loaded);
  }

  private fileFor(tenantId: string): string {
    return path.join(this.stateDir, "packs", `${tenantId}.json`);
  }
}
