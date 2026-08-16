import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { newId } from "../ids.js";
import { loadRecordStore, saveRecordStore } from "./store.js";
import type { TenantRecord } from "./types.js";

/**
 * Generic tenant records on the computer disk core owns — beside facts.json,
 * cards.json, field-tokens.json, and secrets/, never inside disk/ (/home)
 * and never in a pack. Optional computerBaseDir persists; without it the
 * list is empty.
 */
export class RecordBook {
  private readonly records = new Map<string, TenantRecord[]>();
  private readonly hydrated = new Set<string>();
  private readonly corrupt = new Map<string, AvError>();

  constructor(private readonly computerBaseDir?: string) {}

  /**
   * Records on this tenant's disk. Missing file → empty (no invented record).
   * Corrupt store throws. Does not read the request.
   */
  list(tenantId: string): TenantRecord[] {
    this.ensure(tenantId);
    return [...(this.records.get(tenantId) ?? [])];
  }

  get(tenantId: string, id: string): TenantRecord | undefined {
    return this.list(tenantId).find((record) => record.id === id);
  }

  has(tenantId: string, id: string): boolean {
    return Boolean(this.get(tenantId, id));
  }

  /**
   * Ungated persist of a generic record. Field path must not call this
   * until the owner_instance card is approved.
   */
  put(tenantId: string, input: { type: string; label: string; id?: string }): TenantRecord {
    if (!input.type) {
      throw new AvError("RECORD_TYPE_REQUIRED", "Record type is required");
    }
    if (!input.label) {
      throw new AvError("RECORD_LABEL_REQUIRED", "Record label is required");
    }
    this.ensure(tenantId);
    const record: TenantRecord = {
      id: input.id ?? newId("rec"),
      type: input.type,
      label: input.label,
    };
    const list = this.records.get(tenantId) ?? [];
    list.push(record);
    this.records.set(tenantId, list);
    this.persist(tenantId);
    return record;
  }

  private ensure(tenantId: string): void {
    const failed = this.corrupt.get(tenantId);
    if (failed) throw failed;
    if (!this.computerBaseDir || this.hydrated.has(tenantId)) return;
    this.hydrated.add(tenantId);
    try {
      const store = loadRecordStore(this.fileFor(tenantId));
      this.records.set(tenantId, store.records);
    } catch (err) {
      const closed =
        err instanceof AvError
          ? err
          : new AvError("RECORD_STORE_CORRUPT", "Record store is corrupt; refusing to invent a record");
      this.corrupt.set(tenantId, closed);
      throw closed;
    }
  }

  private persist(tenantId: string): void {
    if (!this.computerBaseDir) return;
    saveRecordStore(this.fileFor(tenantId), { records: this.list(tenantId) });
  }

  private fileFor(tenantId: string): string {
    return computerRoot(this.computerBaseDir!, tenantId).recordsFile;
  }
}
