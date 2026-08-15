export interface AgentRecord {
  id: string;
  tenantId: string;
  seatId: string;
  roleId: string;
  name: string;
  persona: string;
  skills: string[];
  specialties: string[];
  memoryScope: string;
  evalPassed: boolean;
  createdAt: Date;
}

export interface AgentMail {
  id: string;
  tenantId: string;
  fromAgentId: string;
  toAgentId: string;
  body: string;
  createdAt: Date;
}

export type MemoryTier = "working" | "episodic" | "semantic";

export interface AgentMemory {
  id: string;
  tenantId: string;
  agentId: string;
  tier: MemoryTier;
  content: string;
  /**
   * Memory cannot become facts. Always false. Enforced at write.
   */
  isFact: false;
  createdAt: Date;
}

export interface SpawnResult {
  tenantId: string;
  agents: AgentRecord[];
}
