import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { loadFactStore, saveFactStore } from "./store.js";
import type { TenantFact } from "./types.js";

function requireRecordId(recordId?: string): string {
  if (!recordId) {
    throw new AvError("RECORD_ID_REQUIRED", "Record id is required");
  }
  return recordId;
}

/**
 * Generic tenant facts on the computer disk core owns — beside cards.json,
 * field-tokens.json, and secrets/, never inside disk/ (/home) and never in a pack.
 * Optional computerBaseDir persists; without it the present set is empty.
 * Every read and write is scoped to a subject record. There is no tenant-global bucket.
 */
export class FactBook {
  private readonly facts = new Map<string, Map<string, Set<string>>>();
  private readonly hydrated = new Set<string>();
  private readonly corrupt = new Map<string, AvError>();

  constructor(private readonly computerBaseDir?: string) {}

  /**
   * Fact ids present on this tenant's disk for one subject record.
   * Missing or blank recordId fails closed (`RECORD_ID_REQUIRED`).
   * Unknown recordId returns empty (that record has no facts) — not a global set.
   * Missing file → empty (no invented fact). Corrupt store throws.
   */
  presentIds(tenantId: string, recordId: string): string[] {
    const subject = requireRecordId(recordId);
    this.ensure(tenantId);
    const scoped = this.facts.get(tenantId);
    if (!scoped) return [];
    return [...(scoped.get(subject) ?? [])];
  }

  /**
   * Ungated persist of a generic fact id on a subject record. Field path
   * must not call this until the owner_instance card is approved.
   * Missing or blank recordId fails closed (`RECORD_ID_REQUIRED`).
   */
  put(tenantId: string, id: string, recordId: string): TenantFact {
    if (!id) {
      throw new AvError("FACT_ID_REQUIRED", "Fact id is required");
    }
    const subject = requireRecordId(recordId);
    this.ensure(tenantId);
    const scoped = this.facts.get(tenantId) ?? new Map<string, Set<string>>();
    const set = scoped.get(subject) ?? new Set<string>();
    set.add(id);
    scoped.set(subject, set);
    this.facts.set(tenantId, scoped);
    this.persist(tenantId);
    return { id, recordId: subject };
  }

  /**
   * Ungated retract of a generic fact id on a subject record. Field path
   * must not call this until the owner_instance card is approved. Missing
   * id is a no-op persist. Missing or blank recordId fails closed.
   */
  retract(tenantId: string, id: string, recordId: string): TenantFact {
    if (!id) {
      throw new AvError("FACT_ID_REQUIRED", "Fact id is required");
    }
    const subject = requireRecordId(recordId);
    this.ensure(tenantId);
    const scoped = this.facts.get(tenantId) ?? new Map<string, Set<string>>();
    const set = scoped.get(subject) ?? new Set<string>();
    set.delete(id);
    scoped.set(subject, set);
    this.facts.set(tenantId, scoped);
    this.persist(tenantId);
    return { id, recordId: subject };
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
        if (!fact.recordId) continue;
        const set = scoped.get(fact.recordId) ?? new Set<string>();
        set.add(fact.id);
        scoped.set(fact.recordId, set);
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
    for (const [recordId, ids] of scoped) {
      for (const id of ids) {
        facts.push({ id, recordId });
      }
    }
    saveFactStore(this.fileFor(tenantId), { facts });
  }

  private fileFor(tenantId: string): string {
    return computerRoot(this.computerBaseDir!, tenantId).factsFile;
  }
}
