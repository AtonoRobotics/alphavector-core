import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { newId } from "../ids.js";
import { loadRecordStore, parseRecordAttributes, saveRecordStore } from "./store.js";
import type { RecordUpdatePatch, TenantRecord } from "./types.js";

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
   * until the owner_instance card is approved. Attributes default to {}.
   */
  put(
    tenantId: string,
    input: { type: string; label: string; id?: string; attributes?: Record<string, string> },
  ): TenantRecord {
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
      attributes: parseRecordAttributes(input.attributes ?? {}),
    };
    const list = this.records.get(tenantId) ?? [];
    list.push(record);
    this.records.set(tenantId, list);
    this.persist(tenantId);
    return record;
  }

  /**
   * Ungated merge of label, type, and/or attributes on a known record.
   * Field path must not call this until the owner_instance card is approved.
   * Unknown id fails closed. Attribute keys merge; existing keys not in the
   * patch stay. Does not invent keys.
   */
  update(tenantId: string, id: string, patch: RecordUpdatePatch): TenantRecord {
    if (!id) {
      throw new AvError("RECORD_ID_REQUIRED", "Record id is required");
    }
    this.ensure(tenantId);
    const list = this.records.get(tenantId) ?? [];
    const index = list.findIndex((record) => record.id === id);
    if (index < 0) {
      throw new AvError("RECORD_NOT_FOUND", `Unknown record ${id}`);
    }
    const current = list[index]!;
    if (patch.type !== undefined && !patch.type) {
      throw new AvError("RECORD_TYPE_REQUIRED", "Record type is required");
    }
    if (patch.label !== undefined && !patch.label) {
      throw new AvError("RECORD_LABEL_REQUIRED", "Record label is required");
    }
    const merged = parseRecordAttributes({
      ...current.attributes,
      ...parseRecordAttributes(patch.attributes ?? {}),
    });
    const next: TenantRecord = {
      id: current.id,
      type: patch.type ?? current.type,
      label: patch.label ?? current.label,
      attributes: merged,
    };
    list[index] = next;
    this.records.set(tenantId, list);
    this.persist(tenantId);
    return next;
  }

  /**
   * Ungated remove of one attribute key on a known record.
   * Field path must not call this until the owner_instance card is approved.
   * Unknown id or unknown/blank key fails closed. Does not invent keys.
   */
  retractAttribute(tenantId: string, id: string, key: string): TenantRecord {
    if (!id) {
      throw new AvError("RECORD_ID_REQUIRED", "Record id is required");
    }
    if (!key) {
      throw new AvError("RECORD_ATTRIBUTE_KEY_REQUIRED", "Attribute key is required");
    }
    this.ensure(tenantId);
    const list = this.records.get(tenantId) ?? [];
    const index = list.findIndex((record) => record.id === id);
    if (index < 0) {
      throw new AvError("RECORD_NOT_FOUND", `Unknown record ${id}`);
    }
    const current = list[index]!;
    if (!(key in current.attributes)) {
      throw new AvError("RECORD_ATTRIBUTE_NOT_FOUND", `Unknown attribute key ${key}`);
    }
    const nextAttributes = { ...current.attributes };
    delete nextAttributes[key];
    const next: TenantRecord = {
      id: current.id,
      type: current.type,
      label: current.label,
      attributes: nextAttributes,
    };
    list[index] = next;
    this.records.set(tenantId, list);
    this.persist(tenantId);
    return next;
  }

  /**
   * Ungated remove of a known record. Field path must not call this until
   * the owner_instance card is approved. Unknown or blank id fails closed.
   * Does not invent a record and does not delete-on-empty-string.
   */
  remove(tenantId: string, id: string): TenantRecord {
    if (!id) {
      throw new AvError("RECORD_ID_REQUIRED", "Record id is required");
    }
    this.ensure(tenantId);
    const list = this.records.get(tenantId) ?? [];
    const index = list.findIndex((record) => record.id === id);
    if (index < 0) {
      throw new AvError("RECORD_NOT_FOUND", `Unknown record ${id}`);
    }
    const [removed] = list.splice(index, 1);
    this.records.set(tenantId, list);
    this.persist(tenantId);
    return removed!;
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
