import type { AgentRuntime } from "../agents/runtime.js";
import type { EvalRunner } from "../eval/runner.js";
import { AvError, PackLoadError } from "../errors.js";
import type { GrantBook } from "../grants/store.js";
import type { HabitatKernel } from "../habitat/kernel.js";
import type { WorkerRecord } from "../habitat/types.js";
import type { PackLoader } from "../packs/loader.js";
import type { LoadedPack } from "../packs/types.js";
import type { ArchitectEvalStatus, ArchitectHabitatSeat, ArchitectWorkerView } from "./types.js";

export interface ArchitectSurfaceDeps {
  agents: AgentRuntime;
  habitat: HabitatKernel;
  grants: GrantBook;
  eval: EvalRunner;
  packs: PackLoader;
}

/**
 * Architect seat in the habitat. Same class of presence as sitting in Grok Bot:
 * org, open runs, workers, grants, eval, isolation as live records.
 * Five booleans are not this seat. Credential gate is architectSit / HTTP.
 */
export class ArchitectSurface {
  constructor(private readonly deps?: ArchitectSurfaceDeps) {}

  /**
   * Live habitat seat. Not five true/false flags.
   * Callers that accept a field token must gate first (architectSit or HTTP).
   */
  sit(tenantId: string): ArchitectHabitatSeat {
    const deps = this.requireDeps();
    const pack = peekActivePack(deps.packs, tenantId);
    const workers = deps.habitat.listWorkers(tenantId).map(toWorkerView);
    return {
      tenantId,
      org: deps.agents.list(tenantId),
      runs: deps.habitat.openRuns(tenantId),
      workers,
      grants: deps.grants.list(tenantId),
      eval: evalStatus(deps.eval, pack),
      isolation: deps.habitat.isolation(tenantId),
    };
  }

  /** Product seat is sit(). home(tenantId) is that seat, not five booleans. */
  home(tenantId: string): ArchitectHabitatSeat {
    return this.sit(tenantId);
  }

  private requireDeps(): ArchitectSurfaceDeps {
    if (!this.deps) {
      throw new AvError("ARCHITECT_SEAT_UNBOUND", "Architect seat requires a live habitat");
    }
    return this.deps;
  }
}

function peekActivePack(packs: PackLoader, tenantId: string): LoadedPack | undefined {
  try {
    return packs.active(tenantId);
  } catch (err) {
    if (err instanceof PackLoadError && err.code === "NO_ACTIVE_PACK") return undefined;
    throw err;
  }
}

function evalStatus(runner: EvalRunner, pack: LoadedPack | undefined): ArchitectEvalStatus {
  if (!pack) {
    return { passed: false, failed: ["no active pack"], fixtures: [] };
  }
  const result = runner.run(pack);
  return {
    passed: result.passed,
    failed: [...result.failed],
    fixtures: pack.binding.evidenceEvalFixtures.map((fixture) => ({
      id: fixture.id,
      kind: fixture.kind,
      countsAsIndependentOutcome: fixture.countsAsIndependentOutcome,
    })),
  };
}

function toWorkerView(worker: WorkerRecord): ArchitectWorkerView {
  return {
    workerId: worker.workerId,
    tenantId: worker.tenantId,
    runId: worker.runId,
    type: worker.type,
    isolation: worker.isolation,
    trailerPath: worker.trailerPath,
    branch: worker.branch,
    agentId: worker.agent.agentId,
    createdAt: worker.createdAt,
  };
}
