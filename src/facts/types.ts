/** Generic tenant fact. Pack-local id string; not an RE or Mission Control type. */
export interface TenantFact {
  id: string;
}

export interface TenantFactStore {
  facts: TenantFact[];
}
