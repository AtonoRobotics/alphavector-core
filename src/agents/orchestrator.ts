import { AvError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type { AgentRecord } from "./types.js";

export interface DispatchPacket {
  packetId: string;
  tenantId: string;
  goal: string;
  assigneeAgentId: string;
  freeze?: string;
  createdAt: string;
}

/**
 * One goal at a time. Packets, not min-slices.
 * Orchestrator cannot grant trust, promote policy, or execute external effects itself.
 */
export class Orchestrator {
  private currentGoal = new Map<string, string>();
  private readonly packets: DispatchPacket[] = [];

  dispatch(input: {
    orchestrator: AgentRecord;
    assignee: AgentRecord;
    goal: string;
    freeze?: string;
  }): DispatchPacket {
    if (!input.orchestrator.isOrchestrator) {
      throw new AvError("NOT_ORCHESTRATOR", "Only the orchestrator may dispatch");
    }
    const existing = this.currentGoal.get(input.orchestrator.tenantId);
    if (existing && existing !== input.goal) {
      throw new AvError("ONE_GOAL", "Orchestrator SHALL dispatch one goal at a time");
    }
    this.currentGoal.set(input.orchestrator.tenantId, input.goal);
    const packet: DispatchPacket = {
      packetId: newId("packet"),
      tenantId: input.orchestrator.tenantId,
      goal: input.goal,
      assigneeAgentId: input.assignee.agentId,
      freeze: input.freeze,
      createdAt: nowIso(),
    };
    this.packets.push(packet);
    return packet;
  }

  completeGoal(tenantId: string): void {
    this.currentGoal.delete(tenantId);
  }

  cannotGrantTrust(): true {
    return true;
  }
}
