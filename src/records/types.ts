/** Generic tenant record. Pack-local type string; not an RE or Mission Control column. */
export interface TenantRecord {
  id: string;
  type: string;
  label: string;
}

export interface TenantRecordStore {
  records: TenantRecord[];
}
