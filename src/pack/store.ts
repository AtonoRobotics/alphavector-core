import type { LoadedPack } from "./types.js";

export interface PackStore {
  activate(pack: LoadedPack): Promise<void>;
  getActive(tenantId: string): Promise<LoadedPack | undefined>;
}

export class MemoryPackStore implements PackStore {
  private readonly active = new Map<string, LoadedPack>();

  async activate(pack: LoadedPack): Promise<void> {
    this.active.set(pack.tenantId, pack);
  }

  async getActive(tenantId: string): Promise<LoadedPack | undefined> {
    return this.active.get(tenantId);
  }
}
