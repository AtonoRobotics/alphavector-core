import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AgentMail, AgentMemory, AgentRecord } from "../agents/types.js";
import type { AgentStore } from "../agents/store.js";
import type { LoadedPack, PackDocument } from "../pack/types.js";
import type { PackStore } from "../pack/store.js";
import type { Assertion, GraphEdge, Journey, Party, RecordItem } from "./types.js";
import type { DataPlaneStore } from "./plane.js";

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 8 });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations/001_init.sql");
  const sql = await readFile(file, "utf8");
  await pool.query(sql);
}

export class PostgresPackStore implements PackStore {
  constructor(private readonly pool: pg.Pool) {}

  async activate(pack: LoadedPack): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE packs SET active = false WHERE tenant_id = $1", [pack.tenantId]);
      await client.query(
        `INSERT INTO packs (
           id, tenant_id, pack_id, version, canonical_bytes, document,
           pack_signature, owner_signature, active, loaded_by, loaded_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)`,
        [
          `${pack.tenantId}:${pack.document.identity.packId}:${pack.document.identity.version}:${pack.loadedAt.toISOString()}`,
          pack.tenantId,
          pack.document.identity.packId,
          pack.document.identity.version,
          pack.canonicalBytes,
          pack.document,
          pack.document.signatures.pack.signature,
          pack.document.signatures.owner.signature,
          pack.loadedBy,
          pack.loadedAt,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getActive(tenantId: string): Promise<LoadedPack | undefined> {
    const result = await this.pool.query(
      "SELECT tenant_id, document, canonical_bytes, loaded_by, loaded_at FROM packs WHERE tenant_id = $1 AND active = true",
      [tenantId],
    );
    const row = result.rows[0] as
      | {
          tenant_id: string;
          document: PackDocument;
          canonical_bytes: Buffer;
          loaded_by: string;
          loaded_at: Date;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      tenantId: row.tenant_id,
      document: row.document,
      canonicalBytes: row.canonical_bytes,
      loadedBy: row.loaded_by,
      loadedAt: row.loaded_at,
    };
  }
}

export class PostgresAgentStore implements AgentStore {
  constructor(private readonly pool: pg.Pool) {}

  async replaceTenantAgents(tenantId: string, agents: AgentRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
      for (const agent of agents) {
        await client.query(
          `INSERT INTO agents (
             id, tenant_id, seat_id, role_id, name, persona, skills, specialties, memory_scope, eval_passed, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            agent.id,
            agent.tenantId,
            agent.seatId,
            agent.roleId,
            agent.name,
            agent.persona,
            agent.skills,
            agent.specialties,
            agent.memoryScope,
            agent.evalPassed,
            agent.createdAt,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(tenantId: string): Promise<AgentRecord[]> {
    const result = await this.pool.query("SELECT * FROM agents WHERE tenant_id = $1 ORDER BY name", [tenantId]);
    return result.rows.map(mapAgent);
  }

  async getByName(tenantId: string, name: string): Promise<AgentRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM agents WHERE tenant_id = $1 AND name = $2", [tenantId, name]);
    return result.rows[0] ? mapAgent(result.rows[0]) : undefined;
  }

  async get(agentId: string): Promise<AgentRecord | undefined> {
    const result = await this.pool.query("SELECT * FROM agents WHERE id = $1", [agentId]);
    return result.rows[0] ? mapAgent(result.rows[0]) : undefined;
  }

  async markEvalPassed(agentId: string): Promise<void> {
    await this.pool.query("UPDATE agents SET eval_passed = true WHERE id = $1", [agentId]);
  }

  async insertMail(mail: AgentMail): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_mail (id, tenant_id, from_agent_id, to_agent_id, body, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [mail.id, mail.tenantId, mail.fromAgentId, mail.toAgentId, mail.body, mail.createdAt],
    );
  }

  async listMail(tenantId: string, agentId: string): Promise<AgentMail[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_mail
       WHERE tenant_id = $1 AND (from_agent_id = $2 OR to_agent_id = $2)
       ORDER BY created_at`,
      [tenantId, agentId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      fromAgentId: row.from_agent_id,
      toAgentId: row.to_agent_id,
      body: row.body,
      createdAt: row.created_at,
    }));
  }

  async insertMemory(memory: AgentMemory): Promise<void> {
    await this.pool.query(
      `INSERT INTO memories (id, tenant_id, agent_id, tier, content, is_fact, created_at)
       VALUES ($1,$2,$3,$4,$5,false,$6)`,
      [memory.id, memory.tenantId, memory.agentId, memory.tier, memory.content, memory.createdAt],
    );
  }

  async listMemory(agentId: string): Promise<AgentMemory[]> {
    const result = await this.pool.query("SELECT * FROM memories WHERE agent_id = $1 ORDER BY created_at", [agentId]);
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      tier: row.tier,
      content: row.content,
      isFact: false as const,
      createdAt: row.created_at,
    }));
  }
}

export class PostgresDataPlaneStore implements DataPlaneStore {
  constructor(private readonly pool: pg.Pool) {}

  async insertParty(party: Party): Promise<void> {
    await this.pool.query(
      "INSERT INTO parties (id, tenant_id, kind, payload, created_at) VALUES ($1,$2,$3,$4,$5)",
      [party.id, party.tenantId, party.kind, party.payload, party.createdAt],
    );
  }
  async insertRecord(record: RecordItem): Promise<void> {
    await this.pool.query(
      "INSERT INTO records (id, tenant_id, kind, payload, created_at) VALUES ($1,$2,$3,$4,$5)",
      [record.id, record.tenantId, record.kind, record.payload, record.createdAt],
    );
  }
  async insertJourney(journey: Journey): Promise<void> {
    await this.pool.query(
      "INSERT INTO journeys (id, tenant_id, kind, stage, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [journey.id, journey.tenantId, journey.kind, journey.stage, journey.payload, journey.createdAt],
    );
  }
  async insertAssertion(assertion: Assertion): Promise<void> {
    await this.pool.query(
      "INSERT INTO assertions (id, tenant_id, subject, predicate, object, evidence_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        assertion.id,
        assertion.tenantId,
        assertion.subject,
        assertion.predicate,
        assertion.object,
        assertion.evidenceId ?? null,
        assertion.status,
        assertion.createdAt,
      ],
    );
  }
  async insertEdge(edge: GraphEdge): Promise<void> {
    await this.pool.query(
      "INSERT INTO graph_edges (id, tenant_id, from_id, to_id, kind) VALUES ($1,$2,$3,$4,$5)",
      [edge.id, edge.tenantId, edge.fromId, edge.toId, edge.kind],
    );
  }
  async listParties(tenantId: string): Promise<Party[]> {
    const result = await this.pool.query("SELECT * FROM parties WHERE tenant_id = $1", [tenantId]);
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      kind: row.kind,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }
  async listRecords(tenantId: string): Promise<RecordItem[]> {
    const result = await this.pool.query("SELECT * FROM records WHERE tenant_id = $1", [tenantId]);
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      kind: row.kind,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }
  async listJourneys(tenantId: string): Promise<Journey[]> {
    const result = await this.pool.query("SELECT * FROM journeys WHERE tenant_id = $1", [tenantId]);
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      kind: row.kind,
      stage: row.stage,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }
  async listAssertions(tenantId: string): Promise<Assertion[]> {
    const result = await this.pool.query("SELECT * FROM assertions WHERE tenant_id = $1", [tenantId]);
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      evidenceId: row.evidence_id ?? undefined,
      status: row.status,
      createdAt: row.created_at,
    }));
  }
  async listEdges(tenantId: string): Promise<GraphEdge[]> {
    const result = await this.pool.query("SELECT * FROM graph_edges WHERE tenant_id = $1", [tenantId]);
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      fromId: row.from_id,
      toId: row.to_id,
      kind: row.kind,
    }));
  }
}

function mapAgent(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    seatId: String(row.seat_id),
    roleId: String(row.role_id),
    name: String(row.name),
    persona: String(row.persona),
    skills: row.skills as string[],
    specialties: row.specialties as string[],
    memoryScope: String(row.memory_scope),
    evalPassed: Boolean(row.eval_passed),
    createdAt: row.created_at as Date,
  };
}
