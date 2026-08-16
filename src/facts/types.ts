/** Generic tenant fact. Pack-local id string; not an RE or Mission Control type. */
export interface TenantFact {
  id: string;
  /** Subject record this fact is about. Required on disk; missing is corrupt, not a global bucket. */
  recordId: string;
}

export interface TenantFactStore {
  facts: TenantFact[];
}
