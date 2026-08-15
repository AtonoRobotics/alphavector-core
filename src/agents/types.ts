export interface AgentRecord {
  agentId: string;
  tenantId: string;
  name: string;
  persona: string;
  skills: string[];
  specialties: string[];
  isOrchestrator: boolean;
  createdAt: string;
}

export interface AgentEnvelope {
  agentId: string;
  tenantId: string;
  name: string;
  persona: string;
  skills: string[];
  specialties: string[];
  memoryScope: {
    agent: string;
    user: string;
    tenant: string;
  };
}

export interface MailMessage {
  messageId: string;
  tenantId: string;
  fromAgentId: string;
  toAgentId: string;
  body: string;
  createdAt: string;
  confersAuthority: false;
}

export interface MemoryEntry {
  memoryId: string;
  tenantId: string;
  tier: "agent" | "user" | "tenant";
  subjectId: string;
  text: string;
  createdAt: string;
  isFact: false;
}
