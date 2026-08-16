/** Generic tenant record. Pack-local type string; not an RE or Mission Control column. */
export interface TenantRecord {
  id: string;
  type: string;
  label: string;
  /** Pack-agnostic string keys and string values. Not phone/email/mls columns. */
  attributes: Record<string, string>;
}

export interface TenantRecordStore {
  records: TenantRecord[];
}

/** Partial update. Omitted fields stay. Attribute keys merge; they are not replaced wholesale. */
export interface RecordUpdatePatch {
  type?: string;
  label?: string;
  attributes?: Record<string, string>;
}
