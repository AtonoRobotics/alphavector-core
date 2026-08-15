import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { loadFactStore, saveFactStore } from "./store.js";
import type { TenantFact } from "./types.js";

/**
 * Generic tenant facts on the computer disk core owns — beside cards.json,
 * field-tokens.json, and secrets/, never inside disk/ (/home) and never in a pack.
 * Optional computerBaseDir persists; without it the present set is empty.
 */
export class FactBook {
  private readonly facts = new Map<string, Set<string>>();
  private readonly hydrated = new Set<string>();
  private readonly corrupt = new Map<string, AvError>();

  constructor(private readonly computerBaseDir?: string) {}

  /**
   * Fact ids present on this tenant's disk. Missing file → empty (no invented fact).
   * Corrupt store throws. Does not read the request.
   */
  presentIds(tenantId: string): string[] {
    this.ensure(tenantId);
    return [...(this.facts.get(tenantId) ?? [])];
  }

  /**
   * Ungated persist of a generic fact id. Field path must not call this
   * until the owner_instance card is approved.
   */
  put(tenantId: string, id: string): TenantFact {
    if (!id) {
      throw new AvError("FACT_ID_REQUIRED", "Fact id is required");
    }
    this.ensure(tenantId);
    const set = this.facts.get(tenantId) ?? new Set<string>();
    set.add(id);
    this.facts.set(tenantId, set);
    this.persist(tenantId);
    return { id };
  }

  /**
   * Ungated retract of a generic fact id. Field path must not call this
   * until the owner_instance card is approved. Missing id is a no-op persist.
   */
  retract(tenantId: string, id: string): TenantFact {
    if (!id) {
      throw new AvError("FACT_ID_REQUIRED", "Fact id is required");
    }
    this.ensure(tenantId);
    const set = this.facts.get(tenantId) ?? new Set<string>();
    set.delete(id);
    this.facts.set(tenantId, set);
    this.persist(tenantId);
    return { id };
  }

  private ensure(tenantId: string): void {
    const failed = this.corrupt.get(tenantId);
    if (failed) throw failed;
    if (!this.computerBaseDir || this.hydrated.has(tenantId)) return;
    this.hydrated.add(tenantId);
    try {
      const store = loadFactStore(this.fileFor(tenantId));
      this.facts.set(tenantId, new Set(store.facts.map((fact) => fact.id)));
    } catch (err) {
      const closed =
        err instanceof AvError
          ? err
          : new AvError("FACT_STORE_CORRUPT", "Fact store is corrupt; refusing to invent a fact");
      this.corrupt.set(tenantId, closed);
      throw closed;
    }
  }

  private persist(tenantId: string): void {
    if (!this.computerBaseDir) return;
    const facts = this.presentIds(tenantId).map((id) => ({ id }));
    saveFactStore(this.fileFor(tenantId), { facts });
  }

  private fileFor(tenantId: string): string {
    return computerRoot(this.computerBaseDir!, tenantId).factsFile;
  }
}
