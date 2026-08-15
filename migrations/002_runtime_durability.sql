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
