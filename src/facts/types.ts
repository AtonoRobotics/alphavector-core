/** Generic tenant fact. Pack-local id string; not an RE or Mission Control type. */
export interface TenantFact {
  id: string;
  /** Subject record id when the fact is about a person/record. Absent = tenant-global. */
  recordId?: string;
}

export interface TenantFactStore {
  facts: TenantFact[];
}
