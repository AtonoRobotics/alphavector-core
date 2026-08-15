import { FailClosedError } from "../errors.js";
import { newId } from "../ids.js";
import type { AgentMemory, MemoryTier } from "./types.js";
import type { AgentStore } from "./store.js";

export class AgentMemoryStore {
  constructor(private readonly store: AgentStore) {}

  async write(input: {
    tenantId: string;
    agentId: string;
    tier: MemoryTier;
    content: string;
    claimedAsFact?: boolean;
  }): Promise<AgentMemory> {
    if (input.claimedAsFact) {
      throw new FailClosedError("MEMORY_NOT_FACT", "Memory cannot become facts.");
    }
    const agent = await this.store.get(input.agentId);
    if (!agent || agent.tenantId !== input.tenantId) {
      throw new FailClosedError("MEMORY_AGENT_UNKNOWN", "Agent is not on this tenant.");
    }
    const memory: AgentMemory = {
      id: newId("mem"),
      tenantId: input.tenantId,
      agentId: input.agentId,
      tier: input.tier,
      content: input.content,
      isFact: false,
      createdAt: new Date(),
    };
    await this.store.insertMemory(memory);
    return memory;
  }
}
