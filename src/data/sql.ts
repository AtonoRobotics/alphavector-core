/** PostgreSQL schema. Production business truth (DEC-005). Pack kinds are data, not columns. */
export const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_lineage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  party_kind TEXT NOT NULL,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_lineage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS journeys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_lineage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  journey_kind TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assertions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_lineage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  typed_value JSONB NOT NULL,
  classification TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_actor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_lineage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  action_class TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  channel TEXT,
  purpose TEXT,
  subject_id TEXT
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_lineage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  produced_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_lineage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  action_id TEXT NOT NULL,
  independent BOOLEAN NOT NULL DEFAULT TRUE,
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  action_class TEXT NOT NULL,
  state TEXT NOT NULL,
  bounds JSONB NOT NULL,
  evidence_ids JSONB NOT NULL,
  eval_ids JSONB NOT NULL,
  owner TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoke_reason TEXT,
  field_notice_issued_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS packs (
  tenant_id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  version TEXT NOT NULL,
  document JSONB NOT NULL,
  loaded_by TEXT NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_computers (
  tenant_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  image_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_agents (
  agent_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  persona TEXT NOT NULL,
  skills JSONB NOT NULL,
  specialties JSONB NOT NULL,
  is_orchestrator BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_cards (
  card_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  action_class TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  subject TEXT NOT NULL,
  channel TEXT NOT NULL,
  field_language JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);
`;
