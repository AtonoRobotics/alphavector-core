import type { AgentMail, AgentMemory, AgentRecord } from "./types.js";

export interface AgentStore {
  replaceTenantAgents(tenantId: string, agents: AgentRecord[]): Promise<void>;
  list(tenantId: string): Promise<AgentRecord[]>;
  getByName(tenantId: string, name: string): Promise<AgentRecord | undefined>;
  get(agentId: string): Promise<AgentRecord | undefined>;
  markEvalPassed(agentId: string): Promise<void>;
  insertMail(mail: AgentMail): Promise<void>;
  listMail(tenantId: string, agentId: string): Promise<AgentMail[]>;
  insertMemory(memory: AgentMemory): Promise<void>;
  listMemory(agentId: string): Promise<AgentMemory[]>;
}

export class MemoryAgentStore implements AgentStore {
  private readonly byTenant = new Map<string, AgentRecord[]>();
  private readonly mail: AgentMail[] = [];
  private readonly memories: AgentMemory[] = [];

  async replaceTenantAgents(tenantId: string, agents: AgentRecord[]): Promise<void> {
    this.byTenant.set(tenantId, agents);
  }

  async list(tenantId: string): Promise<AgentRecord[]> {
    return [...(this.byTenant.get(tenantId) ?? [])];
  }

  async getByName(tenantId: string, name: string): Promise<AgentRecord | undefined> {
    return (this.byTenant.get(tenantId) ?? []).find((agent) => agent.name === name);
  }

  async get(agentId: string): Promise<AgentRecord | undefined> {
    for (const agents of this.byTenant.values()) {
      const found = agents.find((agent) => agent.id === agentId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  async markEvalPassed(agentId: string): Promise<void> {
    for (const agents of this.byTenant.values()) {
      const agent = agents.find((item) => item.id === agentId);
      if (agent) {
        agent.evalPassed = true;
      }
    }
  }

  async insertMail(mail: AgentMail): Promise<void> {
    this.mail.push(mail);
  }

  async listMail(tenantId: string, agentId: string): Promise<AgentMail[]> {
    return this.mail.filter(
      (item) => item.tenantId === tenantId && (item.toAgentId === agentId || item.fromAgentId === agentId),
    );
  }

  async insertMemory(memory: AgentMemory): Promise<void> {
    this.memories.push(memory);
  }

  async listMemory(agentId: string): Promise<AgentMemory[]> {
    return this.memories.filter((item) => item.agentId === agentId);
  }
}
