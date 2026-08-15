import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../persist/json-file.js";
import type { PackRegistry } from "./loader.js";
import type { LoadedPack } from "./types.js";

/**
 * Durable pack registry. One active pack per tenant, persisted on disk.
 * MemoryPackRegistry remains for unit tests that do not need process restart.
 */
export class FilePackRegistry implements PackRegistry {
  constructor(private readonly stateDir: string) {}

  getActive(tenantId: string): LoadedPack | undefined {
    return readJsonFile<LoadedPack>(this.fileFor(tenantId));
  }

  setActive(loaded: LoadedPack): void {
    writeJsonAtomic(this.fileFor(loaded.tenantId), loaded);
  }

  private fileFor(tenantId: string): string {
    return path.join(this.stateDir, "packs", `${tenantId}.json`);
  }
}
