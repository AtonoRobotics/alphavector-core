import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { loadFactStore, saveFactStore } from "./store.js";
import type { TenantFact } from "./types.js";

const GLOBAL = "";

/**
 * Generic tenant facts on the computer disk core owns — beside cards.json,
 * field-tokens.json, and secrets/, never inside disk/ (/home) and never in a pack.
 * Optional computerBaseDir persists; without it the present set is empty.
 */
export class FactBook {
  private readonly facts = new Map<string, Map<string, Set<string>>>();
  private readonly hydrated = new Set<string>();
  private readonly corrupt = new Map<string, AvError>();

  constructor(private readonly computerBaseDir?: string) {}

  /**
   * Fact ids present on this tenant's disk.
   * No recordId → tenant-global facts (Open / journey REQUIRES).
   * With recordId → facts attached to that subject record.
   * Missing file → empty (no invented fact). Corrupt store throws.
   */
  presentIds(tenantId: string, recordId?: string): string[] {
    this.ensure(tenantId);
    const scoped = this.facts.get(tenantId);
    if (!scoped) return [];
    return [...(scoped.get(recordId ?? GLOBAL) ?? [])];
  }

  /**
   * Ungated persist of a generic fact id. Field path must not call this
   * until the owner_instance card is approved.
   */
  put(tenantId: string, id: string, recordId?: string): TenantFact {
    if (!id) {
      throw new AvError("FACT_ID_REQUIRED", "Fact id is required");
    }
    this.ensure(tenantId);
    const scoped = this.facts.get(tenantId) ?? new Map<string, Set<string>>();
    const key = recordId ?? GLOBAL;
    const set = scoped.get(key) ?? new Set<string>();
    set.add(id);
    scoped.set(key, set);
    this.facts.set(tenantId, scoped);
    this.persist(tenantId);
    return recordId ? { id, recordId } : { id };
  }

  /**
   * Ungated retract of a generic fact id. Field path must not call this
   * until the owner_instance card is approved. Missing id is a no-op persist.
   */
  retract(tenantId: string, id: string, recordId?: string): TenantFact {
    if (!id) {
      throw new AvError("FACT_ID_REQUIRED", "Fact id is required");
    }
    this.ensure(tenantId);
    const scoped = this.facts.get(tenantId) ?? new Map<string, Set<string>>();
    const key = recordId ?? GLOBAL;
    const set = scoped.get(key) ?? new Set<string>();
    set.delete(id);
    scoped.set(key, set);
    this.facts.set(tenantId, scoped);
    this.persist(tenantId);
    return recordId ? { id, recordId } : { id };
  }

  private ensure(tenantId: string): void {
    const failed = this.corrupt.get(tenantId);
    if (failed) throw failed;
    if (!this.computerBaseDir || this.hydrated.has(tenantId)) return;
    this.hydrated.add(tenantId);
    try {
      const store = loadFactStore(this.fileFor(tenantId));
      const scoped = new Map<string, Set<string>>();
      for (const fact of store.facts) {
        const key = fact.recordId ?? GLOBAL;
        const set = scoped.get(key) ?? new Set<string>();
        set.add(fact.id);
        scoped.set(key, set);
      }
      this.facts.set(tenantId, scoped);
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
    this.ensure(tenantId);
    const scoped = this.facts.get(tenantId) ?? new Map<string, Set<string>>();
    const facts: TenantFact[] = [];
    for (const [key, ids] of scoped) {
      for (const id of ids) {
        facts.push(key ? { id, recordId: key } : { id });
      }
    }
    saveFactStore(this.fileFor(tenantId), { facts });
  }

  private fileFor(tenantId: string): string {
    return computerRoot(this.computerBaseDir!, tenantId).factsFile;
  }
}
