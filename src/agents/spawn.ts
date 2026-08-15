import { newId } from "../ids.js";
import type { LoadedPack } from "../pack/types.js";
import { FailClosedError } from "../errors.js";
import { assertArchitect, assertSameTenant } from "../principals/guard.js";
import type { Principal } from "../principals/types.js";
import { runPackEval } from "../eval/runner.js";
import type { AgentRecord, SpawnResult } from "./types.js";
import type { AgentStore } from "./store.js";

export interface SpawnRequest {
  tenantId: string;
  principal: Principal;
  pack: LoadedPack;
}

/**
 * DEC-027: no product-constant agent count.
 * Named agents, personas, skills, memory come from the pack org chart.
 * Field user SHALL NOT spawn agents, write personas, or add skills.
 */
export class AgentSpawner {
  constructor(private readonly store: AgentStore) {}

  async spawnFromPack(request: SpawnRequest): Promise<SpawnResult> {
    assertSameTenant(request.principal, request.tenantId);
    assertArchitect(request.principal, "spawn agents, write personas, or add skills");

    if (request.pack.tenantId !== request.tenantId) {
      throw new FailClosedError("PACK_TENANT_MISMATCH", "Pack does not belong to this tenant.");
    }

    const seats = request.pack.document.orgChart.seats;
    if (seats.length < 1) {
      throw new FailClosedError("ORG_CHART_EMPTY", "Pack org chart has no seats.");
    }

    const agents: AgentRecord[] = seats.map((seat) => {
      const role = request.pack.document.roles.find((item) => item.id === seat.roleId);
      if (!role) {
        throw new FailClosedError("ORG_CHART_ROLE_MISSING", `Seat ${seat.seatId} has no role.`);
      }
      return {
        id: newId("agent"),
        tenantId: request.tenantId,
        seatId: seat.seatId,
        roleId: role.id,
        name: seat.agentName,
        persona: role.persona,
        skills: [...role.skills],
        specialties: [...role.specialties],
        memoryScope: role.memoryScope,
        evalPassed: false,
        createdAt: new Date(),
      };
    });

    for (const agent of agents) {
      const evalResult = runPackEval(request.pack.document, agent);
      if (!evalResult.passed) {
        throw new FailClosedError(
          "AGENT_EVAL_FAILED",
          `Agent ${agent.name} failed pack eval: ${evalResult.failures.join("; ")}`,
        );
      }
      agent.evalPassed = true;
    }

    await this.store.replaceTenantAgents(request.tenantId, agents);
    return { tenantId: request.tenantId, agents };
  }
}
