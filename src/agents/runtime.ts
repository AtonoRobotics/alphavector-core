import path from "node:path";
import { AvError, SurfaceViolationError } from "../errors.js";
import { EvalRunner } from "../eval/runner.js";
import { newId, nowIso } from "../ids.js";
import { readJsonFile, writeJsonAtomic } from "../persist/json-file.js";
import type { LoadedPack, PrincipalKind, RoleBinding } from "../packs/types.js";
import type { AgentEnvelope, AgentRecord } from "./types.js";

const evalRunner = new EvalRunner();

/**
 * Unbounded agent runtime (DEC-027). No product-constant N.
 * Agents instantiate from the loaded pack binding.
 * Field users SHALL NOT spawn agents, write personas, or add skills.
 */
export class AgentRuntime {
  private readonly agents = new Map<string, AgentRecord[]>();

  constructor(private readonly stateDir?: string) {}

  instantiateFromPack(pack: LoadedPack, actor: PrincipalKind): AgentRecord[] {
    if (actor === "field") {
      throw new SurfaceViolationError("Field user cannot spawn agents or author the org chart");
    }
    const evalResult = evalRunner.run(pack);
    if (!evalResult.passed) {
      throw new AvError("AGENT_EVAL_FAILED", `Every agent still passes eval: ${evalResult.failed.join("; ")}`);
    }
    const created = pack.binding.roles.map((role) => this.fromRole(pack.tenantId, role));
    this.agents.set(pack.tenantId, created);
    this.persist(pack.tenantId, created);
    return created;
  }

  spawn(actor: PrincipalKind): never {
    if (actor === "field") {
      throw new SurfaceViolationError("Field user cannot spawn agents, write personas, or add skills");
    }
    throw new AvError("ORG_CHART_IS_PACK", "Architect authors the org chart by loading a pack, not by ad-hoc spawn");
  }

  list(tenantId: string): AgentRecord[] {
    if (!this.agents.has(tenantId)) {
      this.hydrate(tenantId);
    }
    return this.agents.get(tenantId) ?? [];
  }

  getByName(tenantId: string, name: string): AgentRecord {
    const found = this.list(tenantId).find((a) => a.name === name);
    if (!found) throw new AvError("AGENT_NOT_FOUND", `No agent named ${name}`);
    return found;
  }

  envelope(agent: AgentRecord): AgentEnvelope {
    return {
      agentId: agent.agentId,
      tenantId: agent.tenantId,
      name: agent.name,
      persona: agent.persona,
      skills: [...agent.skills],
      specialties: [...agent.specialties],
      memoryScope: {
        agent: agent.agentId,
        user: `user:${agent.tenantId}`,
        tenant: agent.tenantId,
      },
    };
  }

  private persist(tenantId: string, agents: AgentRecord[]): void {
    if (!this.stateDir) return;
    writeJsonAtomic(path.join(this.stateDir, "agents", `${tenantId}.json`), agents);
  }

  private hydrate(tenantId: string): void {
    if (!this.stateDir) return;
    const loaded = readJsonFile<AgentRecord[]>(path.join(this.stateDir, "agents", `${tenantId}.json`));
    if (loaded) this.agents.set(tenantId, loaded);
  }

  private fromRole(tenantId: string, role: RoleBinding): AgentRecord {
    return {
      agentId: newId("agent"),
      tenantId,
      name: role.name,
      persona: role.persona,
      skills: [...role.skills],
      specialties: [...role.specialties],
      isOrchestrator: Boolean(role.isOrchestrator),
      createdAt: nowIso(),
    };
  }
}
