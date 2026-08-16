import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AvError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import { applyLedgerSql, connectLedger, ledgerQuery } from "./pg-sync.js";
import { CORE_SCHEMA_SQL } from "./sql.js";
import type {
  ActionRecord,
  Assertion,
  AssertionClass,
  Commitment,
  DurableMeta,
  Evidence,
  GraphEdge,
  GraphNode,
  Interaction,
  Journey,
  Lifecycle,
  Outcome,
  Party,
  RecordObject,
} from "./types.js";

export interface DurableStoreOptions {
  /** Ops/env connection string. Defaults to DATABASE_URL. Not a field control. */
  databaseUrl?: string;
  /** Postgres schema. Product default is public. Tests may share a name to prove restart. */
  schema?: string;
  /** Env to read DATABASE_URL from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

const LEDGER_TABLES = [
  "parties",
  "records",
  "journeys",
  "assertions",
  "actions",
  "evidence",
  "outcomes",
  "commitments",
  "interactions",
  "graph_nodes",
  "graph_edges",
] as const;

function requireDatabaseUrl(env: NodeJS.ProcessEnv, explicit?: string): string {
  const url = (explicit ?? env.DATABASE_URL ?? "").trim();
  if (!url) {
    throw new AvError(
      "DATABASE_URL_REQUIRED",
      "DATABASE_URL is required; PostgreSQL is the only business truth. Refusing to boot an in-process ledger.",
    );
  }
  return url;
}

function defaultSchema(explicit?: string): string {
  if (explicit) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(explicit)) {
      throw new AvError("LEDGER_SCHEMA_INVALID", "Durable store schema name is invalid");
    }
    return explicit;
  }
  if (process.env.VITEST) {
    return `av_${process.pid}_${randomBytes(8).toString("hex")}`;
  }
  return "public";
}

function migrationStatements(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return files.map((name) => readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
}

function applySchema(schema: string): void {
  applyLedgerSql(schema, [CORE_SCHEMA_SQL, ...migrationStatements()]);
}

function iso(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  throw new AvError("LEDGER_ROW_INVALID", "Timestamp is missing from a ledger row");
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new AvError("LEDGER_ROW_INVALID", `${field} is missing from a ledger row`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metaFrom(row: Record<string, unknown>): DurableMeta {
  return {
    tenantId: text(row.tenant_id, "tenant_id"),
    id: text(row.id, "id"),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    sourceLineage: text(row.source_lineage, "source_lineage"),
    lifecycle: text(row.lifecycle, "lifecycle") as Lifecycle,
  };
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AvError("LEDGER_ROW_INVALID", `${field} is missing from a ledger row`);
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AvError("LEDGER_ROW_INVALID", `${field} is missing from a ledger row`);
  }
  return value as string[];
}

function meta(tenantId: string, prefix: string, lineage: string): DurableMeta {
  const ts = nowIso();
  return {
    tenantId,
    id: newId(prefix),
    version: 1,
    createdAt: ts,
    updatedAt: ts,
    sourceLineage: lineage,
    lifecycle: "active",
  };
}

/**
 * Pack-agnostic durable store (DEC-026).
 * PostgreSQL is the only business truth (DEC-005). Missing DATABASE_URL
 * fails closed. This class is the product API; it is not an in-process ledger.
 * Pack kinds stay data, not columns.
 */
export class DurableStore {
  readonly parties: Party[] = [];
  readonly records: RecordObject[] = [];
  readonly journeys: Journey[] = [];
  readonly assertions: Assertion[] = [];
  readonly actions: ActionRecord[] = [];
  readonly outcomes: Outcome[] = [];
  readonly evidence: Evidence[] = [];
  readonly commitments: Commitment[] = [];
  readonly interactions: Interaction[] = [];
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];
  readonly schema: string;

  constructor(opts: DurableStoreOptions = {}) {
    const env = opts.env ?? process.env;
    const url = requireDatabaseUrl(env, opts.databaseUrl);
    this.schema = defaultSchema(opts.schema);
    connectLedger(url);
    applySchema(this.schema);
    this.hydrate();
  }

  /** Relations that exist after apply. Apply is not a comment. */
  appliedRelationNames(): string[] {
    const { rows } = ledgerQuery(
      this.schema,
      "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename",
    );
    return rows.map((row) => text(row.tablename, "tablename"));
  }

  createParty(tenantId: string, partyKind: string, displayName: string): Party {
    const party: Party = { ...meta(tenantId, "party", "user"), partyKind, displayName };
    ledgerQuery(
      this.schema,
      `INSERT INTO parties (
        id, tenant_id, version, created_at, updated_at, source_lineage, lifecycle, party_kind, display_name
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        party.id,
        party.tenantId,
        party.version,
        party.createdAt,
        party.updatedAt,
        party.sourceLineage,
        party.lifecycle,
        party.partyKind,
        party.displayName,
      ],
    );
    this.parties.push(party);
    return party;
  }

  createRecord(tenantId: string, recordKind: string, payload: Record<string, unknown>): RecordObject {
    const rec: RecordObject = { ...meta(tenantId, "rec", "user"), recordKind, payload };
    ledgerQuery(
      this.schema,
      `INSERT INTO records (
        id, tenant_id, version, created_at, updated_at, source_lineage, lifecycle, record_kind, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        rec.id,
        rec.tenantId,
        rec.version,
        rec.createdAt,
        rec.updatedAt,
        rec.sourceLineage,
        rec.lifecycle,
        rec.recordKind,
        JSON.stringify(rec.payload),
      ],
    );
    this.records.push(rec);
    return rec;
  }

  createJourney(
    tenantId: string,
    journeyKind: string,
    objective: string,
    recordId?: string,
  ): Journey {
    const journey: Journey = {
      ...meta(tenantId, "journey", "user"),
      journeyKind,
      objective,
      status: "open",
      ...(recordId ? { recordId } : {}),
    };
    this.insertJourney(journey);
    this.journeys.push(journey);
    return journey;
  }

  /** Rehydrate a persisted journey after process restart. Does not invent fields. */
  restoreJourney(journey: Journey): Journey {
    const existing = this.journeys.find((j) => j.id === journey.id);
    if (existing) return existing;
    this.insertJourney(journey);
    this.journeys.push(journey);
    return journey;
  }

  updateJourney(
    id: string,
    patch: Partial<Pick<Journey, "status" | "version" | "updatedAt">>,
  ): Journey {
    const journey = this.journeys.find((j) => j.id === id);
    if (!journey) throw new AvError("JOURNEY_NOT_FOUND", `Unknown journey ${id}`);
    if (patch.status !== undefined) journey.status = patch.status;
    if (patch.version !== undefined) journey.version = patch.version;
    if (patch.updatedAt !== undefined) journey.updatedAt = patch.updatedAt;
    ledgerQuery(
      this.schema,
      `UPDATE journeys SET status = $2, version = $3, updated_at = $4 WHERE id = $1`,
      [journey.id, journey.status, journey.version, journey.updatedAt],
    );
    return journey;
  }

  assert(input: {
    tenantId: string;
    subjectType: string;
    subjectId: string;
    predicate: string;
    typedValue: unknown;
    classification: AssertionClass;
    confidence: number;
    sourceType: string;
    sourceId: string;
    sourceActor: string;
    actorIsModel?: boolean;
  }): Assertion {
    if (input.classification === "verified" && input.actorIsModel) {
      throw new AvError("MODEL_CANNOT_VERIFY", "A model SHALL NOT write verified assertions");
    }
    const assertion: Assertion = {
      ...meta(input.tenantId, "asrt", input.sourceId),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      predicate: input.predicate,
      typedValue: input.typedValue,
      classification: input.classification,
      confidence: input.confidence,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceActor: input.sourceActor,
    };
    ledgerQuery(
      this.schema,
      `INSERT INTO assertions (
        id, tenant_id, version, created_at, updated_at, source_lineage, lifecycle,
        subject_type, subject_id, predicate, typed_value, classification, confidence,
        source_type, source_id, source_actor
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        assertion.id,
        assertion.tenantId,
        assertion.version,
        assertion.createdAt,
        assertion.updatedAt,
        assertion.sourceLineage,
        assertion.lifecycle,
        assertion.subjectType,
        assertion.subjectId,
        assertion.predicate,
        JSON.stringify(assertion.typedValue),
        assertion.classification,
        assertion.confidence,
        assertion.sourceType,
        assertion.sourceId,
        assertion.sourceActor,
      ],
    );
    this.assertions.push(assertion);
    return assertion;
  }

  proposeAction(input: {
    tenantId: string;
    actionClass: string;
    agentId: string;
    channel?: string;
    purpose?: string;
    subjectId?: string;
  }): ActionRecord {
    const action: ActionRecord = {
      ...meta(input.tenantId, "act", input.agentId),
      actionClass: input.actionClass,
      agentId: input.agentId,
      status: "proposed",
      channel: input.channel,
      purpose: input.purpose,
      subjectId: input.subjectId,
    };
    ledgerQuery(
      this.schema,
      `INSERT INTO actions (
        id, tenant_id, version, created_at, updated_at, source_lineage, lifecycle,
        action_class, agent_id, status, channel, purpose, subject_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        action.id,
        action.tenantId,
        action.version,
        action.createdAt,
        action.updatedAt,
        action.sourceLineage,
        action.lifecycle,
        action.actionClass,
        action.agentId,
        action.status,
        action.channel ?? null,
        action.purpose ?? null,
        action.subjectId ?? null,
      ],
    );
    this.actions.push(action);
    return action;
  }

  updateAction(id: string, status: ActionRecord["status"]): ActionRecord {
    const action = this.actions.find((a) => a.id === id);
    if (!action) throw new AvError("ACTION_NOT_FOUND", id);
    action.status = status;
    action.version += 1;
    action.updatedAt = nowIso();
    const { rowCount } = ledgerQuery(
      this.schema,
      `UPDATE actions SET status = $2, version = $3, updated_at = $4 WHERE id = $1`,
      [action.id, action.status, action.version, action.updatedAt],
    );
    if (rowCount < 1) throw new AvError("ACTION_NOT_FOUND", id);
    return action;
  }

  addEvidence(input: {
    tenantId: string;
    kind: string;
    payload: Record<string, unknown>;
    producedBy: string;
  }): Evidence {
    const ev: Evidence = { ...meta(input.tenantId, "ev", input.producedBy), ...input };
    ledgerQuery(
      this.schema,
      `INSERT INTO evidence (
        id, tenant_id, version, created_at, updated_at, source_lineage, lifecycle, kind, payload, produced_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ev.id,
        ev.tenantId,
        ev.version,
        ev.createdAt,
        ev.updatedAt,
        ev.sourceLineage,
        ev.lifecycle,
        ev.kind,
        JSON.stringify(ev.payload),
        ev.producedBy,
      ],
    );
    this.evidence.push(ev);
    return ev;
  }

  mutateEvidence(_id: string): never {
    throw new AvError("EVIDENCE_IMMUTABLE", "The executing agent cannot modify or delete its evidence");
  }

  deleteEvidence(_id: string): never {
    throw new AvError("EVIDENCE_IMMUTABLE", "The executing agent cannot modify or delete its evidence");
  }

  addOutcome(tenantId: string, actionId: string, summary: string): Outcome {
    const outcome: Outcome = {
      ...meta(tenantId, "out", actionId),
      actionId,
      independent: true,
      summary,
    };
    ledgerQuery(
      this.schema,
      `INSERT INTO outcomes (
        id, tenant_id, version, created_at, updated_at, source_lineage, lifecycle, action_id, independent, summary
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        outcome.id,
        outcome.tenantId,
        outcome.version,
        outcome.createdAt,
        outcome.updatedAt,
        outcome.sourceLineage,
        outcome.lifecycle,
        outcome.actionId,
        outcome.independent,
        outcome.summary,
      ],
    );
    this.outcomes.push(outcome);
    return outcome;
  }

  addCommitment(tenantId: string, parties: string[], deadline?: string): Commitment {
    const c: Commitment = {
      ...meta(tenantId, "cmt", "user"),
      parties,
      deadline,
      status: "open",
    };
    ledgerQuery(
      this.schema,
      `INSERT INTO commitments (
        id, tenant_id, version, created_at, updated_at, source_lineage, lifecycle, parties, deadline, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        c.id,
        c.tenantId,
        c.version,
        c.createdAt,
        c.updatedAt,
        c.sourceLineage,
        c.lifecycle,
        JSON.stringify(c.parties),
        c.deadline ?? null,
        c.status,
      ],
    );
    this.commitments.push(c);
    return c;
  }

  addInteraction(tenantId: string, channel: string, participants: string[], summary: string): Interaction {
    const i: Interaction = {
      ...meta(tenantId, "ix", "user"),
      channel,
      participants,
      summary,
    };
    ledgerQuery(
      this.schema,
      `INSERT INTO interactions (
        id, tenant_id, version, created_at, updated_at, source_lineage, lifecycle, channel, participants, summary
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        i.id,
        i.tenantId,
        i.version,
        i.createdAt,
        i.updatedAt,
        i.sourceLineage,
        i.lifecycle,
        i.channel,
        JSON.stringify(i.participants),
        i.summary,
      ],
    );
    this.interactions.push(i);
    return i;
  }

  projectNode(tenantId: string, kind: string, authoritativeId: string): GraphNode {
    const node: GraphNode = {
      tenantId,
      nodeId: newId("node"),
      kind,
      authoritativeId,
    };
    ledgerQuery(
      this.schema,
      `INSERT INTO graph_nodes (node_id, tenant_id, kind, authoritative_id) VALUES ($1, $2, $3, $4)`,
      [node.nodeId, node.tenantId, node.kind, node.authoritativeId],
    );
    this.nodes.push(node);
    return node;
  }

  projectEdge(input: {
    tenantId: string;
    kind: string;
    fromId: string;
    toId: string;
    assertionId: string;
  }): GraphEdge {
    const edge: GraphEdge = { edgeId: newId("edge"), ...input };
    ledgerQuery(
      this.schema,
      `INSERT INTO graph_edges (edge_id, tenant_id, kind, from_id, to_id, assertion_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [edge.edgeId, edge.tenantId, edge.kind, edge.fromId, edge.toId, edge.assertionId],
    );
    this.edges.push(edge);
    return edge;
  }

  retrieve(tenantId: string, query: string): Array<{ kind: string; id: string; text: string }> {
    const q = query.toLowerCase();
    const hits: Array<{ kind: string; id: string; text: string }> = [];
    for (const p of this.parties.filter((x) => x.tenantId === tenantId)) {
      if (p.displayName.toLowerCase().includes(q) || p.partyKind.toLowerCase().includes(q)) {
        hits.push({ kind: "party", id: p.id, text: p.displayName });
      }
    }
    for (const r of this.records.filter((x) => x.tenantId === tenantId)) {
      if (r.recordKind.toLowerCase().includes(q) || JSON.stringify(r.payload).toLowerCase().includes(q)) {
        hits.push({ kind: "record", id: r.id, text: r.recordKind });
      }
    }
    for (const j of this.journeys.filter((x) => x.tenantId === tenantId)) {
      if (j.objective.toLowerCase().includes(q) || j.journeyKind.toLowerCase().includes(q)) {
        hits.push({ kind: "journey", id: j.id, text: j.objective });
      }
    }
    return hits;
  }

  private insertJourney(journey: Journey): void {
    ledgerQuery(
      this.schema,
      `INSERT INTO journeys (
        id, tenant_id, version, created_at, updated_at, source_lineage, lifecycle,
        journey_kind, objective, status, record_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        journey.id,
        journey.tenantId,
        journey.version,
        journey.createdAt,
        journey.updatedAt,
        journey.sourceLineage,
        journey.lifecycle,
        journey.journeyKind,
        journey.objective,
        journey.status,
        journey.recordId ?? null,
      ],
    );
  }

  private hydrate(): void {
    this.parties.push(
      ...ledgerQuery(this.schema, "SELECT * FROM parties ORDER BY created_at, id").rows.map((row) => ({
        ...metaFrom(row),
        partyKind: text(row.party_kind, "party_kind"),
        displayName: text(row.display_name, "display_name"),
      })),
    );
    this.records.push(
      ...ledgerQuery(this.schema, "SELECT * FROM records ORDER BY created_at, id").rows.map((row) => ({
        ...metaFrom(row),
        recordKind: text(row.record_kind, "record_kind"),
        payload: asObject(row.payload, "payload"),
      })),
    );
    this.journeys.push(
      ...ledgerQuery(this.schema, "SELECT * FROM journeys ORDER BY created_at, id").rows.map((row) => {
        const recordId = optionalText(row.record_id);
        return {
          ...metaFrom(row),
          journeyKind: text(row.journey_kind, "journey_kind"),
          objective: text(row.objective, "objective"),
          status: text(row.status, "status") as Journey["status"],
          ...(recordId ? { recordId } : {}),
        };
      }),
    );
    this.assertions.push(
      ...ledgerQuery(this.schema, "SELECT * FROM assertions ORDER BY created_at, id").rows.map((row) => ({
        ...metaFrom(row),
        subjectType: text(row.subject_type, "subject_type"),
        subjectId: text(row.subject_id, "subject_id"),
        predicate: text(row.predicate, "predicate"),
        typedValue: row.typed_value,
        classification: text(row.classification, "classification") as AssertionClass,
        confidence: Number(row.confidence),
        sourceType: text(row.source_type, "source_type"),
        sourceId: text(row.source_id, "source_id"),
        sourceActor: text(row.source_actor, "source_actor"),
      })),
    );
    this.actions.push(
      ...ledgerQuery(this.schema, "SELECT * FROM actions ORDER BY created_at, id").rows.map((row) => ({
        ...metaFrom(row),
        actionClass: text(row.action_class, "action_class"),
        agentId: text(row.agent_id, "agent_id"),
        status: text(row.status, "status") as ActionRecord["status"],
        channel: optionalText(row.channel),
        purpose: optionalText(row.purpose),
        subjectId: optionalText(row.subject_id),
      })),
    );
    this.evidence.push(
      ...ledgerQuery(this.schema, "SELECT * FROM evidence ORDER BY created_at, id").rows.map((row) => ({
        ...metaFrom(row),
        kind: text(row.kind, "kind"),
        payload: asObject(row.payload, "payload"),
        producedBy: text(row.produced_by, "produced_by"),
      })),
    );
    this.outcomes.push(
      ...ledgerQuery(this.schema, "SELECT * FROM outcomes ORDER BY created_at, id").rows.map((row) => ({
        ...metaFrom(row),
        actionId: text(row.action_id, "action_id"),
        independent: true as const,
        summary: text(row.summary, "summary"),
      })),
    );
    this.commitments.push(
      ...ledgerQuery(this.schema, "SELECT * FROM commitments ORDER BY created_at, id").rows.map((row) => ({
        ...metaFrom(row),
        parties: asStringArray(row.parties, "parties"),
        deadline: optionalText(row.deadline),
        status: text(row.status, "status") as Commitment["status"],
      })),
    );
    this.interactions.push(
      ...ledgerQuery(this.schema, "SELECT * FROM interactions ORDER BY created_at, id").rows.map((row) => ({
        ...metaFrom(row),
        channel: text(row.channel, "channel"),
        participants: asStringArray(row.participants, "participants"),
        summary: text(row.summary, "summary"),
      })),
    );
    this.nodes.push(
      ...ledgerQuery(this.schema, "SELECT * FROM graph_nodes ORDER BY node_id").rows.map((row) => ({
        tenantId: text(row.tenant_id, "tenant_id"),
        nodeId: text(row.node_id, "node_id"),
        kind: text(row.kind, "kind"),
        authoritativeId: text(row.authoritative_id, "authoritative_id"),
      })),
    );
    this.edges.push(
      ...ledgerQuery(this.schema, "SELECT * FROM graph_edges ORDER BY edge_id").rows.map((row) => ({
        tenantId: text(row.tenant_id, "tenant_id"),
        edgeId: text(row.edge_id, "edge_id"),
        kind: text(row.kind, "kind"),
        fromId: text(row.from_id, "from_id"),
        toId: text(row.to_id, "to_id"),
        assertionId: text(row.assertion_id, "assertion_id"),
      })),
    );
  }
}

export const LEDGER_RELATION_NAMES: readonly string[] = LEDGER_TABLES;
