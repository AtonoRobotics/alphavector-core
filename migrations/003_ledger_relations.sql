-- Completes the durable ledger. Pack kinds stay data, not columns (DEC-026).
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS record_id TEXT;

CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_lineage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  parties JSONB NOT NULL,
  deadline TIMESTAMPTZ,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_lineage TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  channel TEXT NOT NULL,
  participants JSONB NOT NULL,
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  node_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  authoritative_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_edges (
  edge_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  assertion_id TEXT NOT NULL
);
