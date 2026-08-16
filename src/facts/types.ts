/** Generic tenant fact. Pack-local id string; not an RE or Mission Control type. */
export interface TenantFact {
  id: string;
  /** Subject record this fact is about. Writes require it. Absent on disk is skipped, not a global bucket. */
  recordId?: string;
}

export interface TenantFactStore {
  facts: TenantFact[];
}
