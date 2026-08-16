import type { AgentRecord } from "../agents/types.js";
import type { Orchestrator } from "../agents/orchestrator.js";
import type { AgentRuntime } from "../agents/runtime.js";
import type { CardBook } from "../auth/cards.js";
import { AuthorizationRequiredError, AvError } from "../errors.js";
import type { EffectExecutor, EffectResult } from "../effects/executor.js";
import { newId, nowIso } from "../ids.js";
import type { LoadedPack } from "../packs/types.js";
import { DryStemAdapter } from "./adapter.js";
import { HabitatMemoryStore } from "./memory-store.js";
import { RunStore } from "./run-store.js";
import { writeSkillFiles } from "./skills.js";
import { stem } from "./stem.js";
import {
  CODER_TYPE,
  HABITAT_OWNED,
  type CognitiveAdapter,
  type CognitiveIntent,
  type LabeledMemory,
  type RunRecord,
  type SkillFile,
  type WakeEvent,
  type WakeResult,
  type WorkerRecord,
} from "./types.js";
import { WakeBus } from "./wake-bus.js";
import { replayWakeLog, WakeLog } from "./wake-log.js";
import { WorkerBook } from "./worker.js";

export interface HabitatKernelOptions {
  computerBaseDir?: string;
  cards: CardBook;
  effects: EffectExecutor;
  agents: AgentRuntime;
  orchestrator: Orchestrator;
  adapter?: CognitiveAdapter;
}

/**
 * Habitat kernel: facilities, not an agent. Deterministic owner of
 * wake, run, worker, skill file, grant/card/pack admission.
 * Sequence: event → load context → adapter thinks → validate → act → sleep.
 */
export class HabitatKernel {
  readonly owns = HABITAT_OWNED;
  readonly bus = new WakeBus();
  readonly memory: HabitatMemoryStore;
  private readonly runs: RunStore;
  private readonly wakeLog: WakeLog;
  private readonly workers: WorkerBook;
  private readonly adapter: CognitiveAdapter;
  private readonly packs = new Map<string, LoadedPack>();

  constructor(private readonly opts: HabitatKernelOptions) {
    this.runs = new RunStore(opts.computerBaseDir);
    this.wakeLog = new WakeLog(opts.computerBaseDir);
    this.workers = new WorkerBook(opts.computerBaseDir);
    this.memory = new HabitatMemoryStore(opts.computerBaseDir);
    this.adapter = opts.adapter ?? new DryStemAdapter();
  }

  getRun(tenantId: string): RunRecord | undefined {
    return this.runs.get(tenantId);
  }

  listWakes(tenantId: string): ReturnType<WakeLog["list"]> {
    return this.wakeLog.list(tenantId);
  }

  activeWorker(tenantId: string): WorkerRecord | undefined {
    return this.workers.get(tenantId);
  }

  activeWorkerAgent(tenantId: string): AgentRecord | undefined {
    return this.workers.get(tenantId)?.agent;
  }

  trailerExists(tenantId: string): boolean {
    return this.workers.trailerExists(tenantId);
  }

  waitForExecutor(tenantId: string, ms = 2000): boolean {
    return this.workers.waitForExecutor(tenantId, ms);
  }

  executorOutput(tenantId: string): string | undefined {
    return this.workers.executorOutput(tenantId);
  }

  /**
   * Field journey start: the product wake, same as
   * `HabitatKernel.wake({ kind: "field_start" })`.
   * Creates or resumes the run, injects labeled memory, and launches the thin
   * coder (executor + branch, trailer isolation). Talking stays thin.
   * A second start with the same goal is follow-up (same worker / same run).
   * A second start with a different goal throws ONE_GOAL — one tenant, one
   * pack, one orchestrator, one goal. Same fail-closed rule as `wake()`.
   */
  observeFieldStart(event: Omit<WakeEvent, "kind"> & { pack: LoadedPack; goal: string }): WakeResult {
    this.packs.set(event.tenantId, event.pack);
    return this.wake({ ...event, kind: "field_start" });
  }

  wake(event: WakeEvent, opts?: { until?: "talking" | "card" | "done"; holdWorker?: boolean }): WakeResult {
    this.bus.emit(event);
    if (event.pack) this.packs.set(event.tenantId, event.pack);
    const pack = event.pack ?? this.packs.get(event.tenantId);
    const decision = stem(event);
    const until = opts?.until ?? defaultUntil(event.kind);

    if (event.kind === "kill") {
      return this.kill(event);
    }
    if (event.kind === "card_decide") {
      return this.cardDecide(event, pack, until);
    }
    if (event.kind === "worker_done") {
      return this.workerDone(event);
    }
    if (event.kind !== "field_start") {
      const memory = this.injectMemory(event.tenantId, this.orchestratorId(event.tenantId));
      this.wakeLog.append({
        kind: event.kind,
        tenantId: event.tenantId,
        at: nowIso(),
        detail: { typedOnly: true },
      });
      return {
        run: this.runs.get(event.tenantId),
        wokeOrchestrator: decision.wakeOrchestrator,
        wokeOps: decision.wakeOps,
        launchedWorker: false,
        talkingDidHeavyWork: false,
        memory,
      };
    }

    return this.fieldStart(event, pack, decision, until, opts?.holdWorker === true);
  }

  replay(tenantId: string): ReturnType<typeof replayWakeLog> {
    return replayWakeLog(this.wakeLog.list(tenantId));
  }

  private fieldStart(
    event: WakeEvent,
    pack: LoadedPack | undefined,
    decision: ReturnType<typeof stem>,
    until: "talking" | "card" | "done",
    holdWorker: boolean,
  ): WakeResult {
    if (!pack) throw new AvError("NO_ACTIVE_PACK", "Habitat start requires a loaded pack");
    if (!event.goal) throw new AvError("GOAL_REQUIRED", "Habitat start requires one goal");
    const existing = this.runs.get(event.tenantId);
    if (existing && !isTerminal(existing.status) && existing.goal !== event.goal) {
      throw new AvError("ONE_GOAL", "Orchestrator SHALL dispatch one goal at a time");
    }
    if (existing && existing.status === "awaiting_card" && existing.goal === event.goal) {
      const memory = this.injectMemory(
        event.tenantId,
        this.workers.get(event.tenantId)?.agent.agentId ?? this.orchestratorId(event.tenantId),
      );
      this.wakeLog.append({
        kind: "field_start",
        tenantId: event.tenantId,
        runId: existing.runId,
        at: nowIso(),
        detail: { followUp: true },
      });
      return {
        run: existing,
        wokeOrchestrator: true,
        wokeOps: false,
        launchedWorker: false,
        talkingDidHeavyWork: false,
        cardId: existing.pendingCardId,
        memory,
      };
    }
    const orch = this.requireOrchestrator(event.tenantId);
    const skills = writeSkillFiles(this.opts.computerBaseDir, pack);
    const run =
      existing && existing.goal === event.goal
        ? existing
        : this.runs.put({
            runId: newId("run"),
            tenantId: event.tenantId,
            goal: event.goal,
            status: "open",
            journeyId: event.journeyId,
            recordId: event.recordId,
            talkingDidHeavyWork: false,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
    this.wakeLog.append({
      kind: "field_start",
      tenantId: event.tenantId,
      runId: run.runId,
      at: nowIso(),
      detail: { goal: event.goal },
    });
    const memory = this.injectMemory(event.tenantId, orch.agentId);
    this.assertLabeled(memory);
    const talking = this.adapter.think({
      pass: "talking",
      event,
      run,
      memory,
      skills,
    });
    this.validateTalking(talking);
    this.runs.put({
      ...run,
      status: "talking",
      pendingIntent: talking.act === "launch_worker" ? "launch_worker" : undefined,
      updatedAt: nowIso(),
    });
    const result: WakeResult = {
      run: this.runs.get(event.tenantId),
      wokeOrchestrator: decision.wakeOrchestrator,
      wokeOps: decision.wakeOps,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
    if (until === "talking") return result;
    return this.actLaunchAndWork(event, pack, orch, skills, holdWorker, until);
  }

  private actLaunchAndWork(
    event: WakeEvent,
    pack: LoadedPack,
    orch: AgentRecord,
    skills: SkillFile[],
    holdWorker: boolean,
    until: "talking" | "card" | "done",
  ): WakeResult {
    const run = this.requireRun(event.tenantId);
    const followUp = Boolean(run.workerId && this.workers.getById(event.tenantId, run.workerId));
    const worker = followUp
      ? this.workers.get(event.tenantId)!
      : this.workers.launch({
          tenantId: event.tenantId,
          runId: run.runId,
          skills,
          hold: holdWorker,
        });
    if (!followUp) {
      this.opts.orchestrator.dispatch({
        orchestrator: orch,
        assignee: worker.agent,
        goal: run.goal,
      });
    }
    this.runs.put({
      ...run,
      status: "working",
      workerId: worker.workerId,
      workerType: CODER_TYPE.id,
      pendingIntent: undefined,
      updatedAt: nowIso(),
    });
    const memory = this.injectMemory(event.tenantId, worker.agent.agentId);
    this.assertLabeled(memory);
    const intent = this.adapter.think({
      pass: "worker",
      event,
      run: this.requireRun(event.tenantId),
      memory,
      skills,
    });
    if (intent.act !== "propose_effect") {
      throw new AvError("WORKER_INTENT", "Worker pass must propose the one external effect");
    }
    const proposed = this.admit(pack, worker.agent, intent);
    if (until === "done" && proposed.effect) {
      return this.finishAfterEffect(event.tenantId, proposed);
    }
    return {
      run: this.requireRun(event.tenantId),
      wokeOrchestrator: true,
      wokeOps: false,
      launchedWorker: !followUp,
      talkingDidHeavyWork: false,
      effect: proposed.effect,
      cardId: proposed.cardId,
      memory,
    };
  }

  private cardDecide(event: WakeEvent, pack: LoadedPack | undefined, until: "talking" | "card" | "done"): WakeResult {
    const run = this.runs.get(event.tenantId);
    const memory = this.injectMemory(
      event.tenantId,
      this.workers.get(event.tenantId)?.agent.agentId ?? this.orchestratorId(event.tenantId),
    );
    this.wakeLog.append({
      kind: "card_decide",
      tenantId: event.tenantId,
      runId: run?.runId,
      at: nowIso(),
      detail: { cardId: event.cardId, decision: event.decision },
    });
    if (!run || !event.cardId || run.pendingCardId !== event.cardId) {
      return {
        run,
        wokeOrchestrator: true,
        wokeOps: event.decision === "approved",
        launchedWorker: false,
        talkingDidHeavyWork: false,
        memory,
      };
    }
    if (event.decision === "denied") {
      this.opts.orchestrator.completeGoal(event.tenantId);
      this.workers.teardown(event.tenantId);
      const next = this.runs.put({
        ...run,
        status: "denied",
        pendingCardId: undefined,
        pendingEffect: undefined,
        updatedAt: nowIso(),
      });
      return {
        run: next,
        wokeOrchestrator: true,
        wokeOps: false,
        launchedWorker: false,
        talkingDidHeavyWork: false,
        memory,
      };
    }
    if (!pack || !run.pendingEffect) {
      throw new AvError("RUN_NOT_RESUMABLE", "Approve resumes the same run; pending effect is missing");
    }
    const worker = this.workers.get(event.tenantId);
    const agent = worker?.agent ?? this.coderFromPending(event.tenantId, run.pendingEffect.agentId);
    const effect = this.opts.effects.execute({
      pack,
      agent,
      actionClass: run.pendingEffect.actionClass,
      channel: run.pendingEffect.channel,
      purpose: run.pendingEffect.purpose,
      subject: run.pendingEffect.subject,
      surface: "field",
      approvedCardId: event.cardId,
    });
    const finished = this.finishAfterEffect(event.tenantId, { effect, cardId: event.cardId });
    if (until === "card") {
      return { ...finished, wokeOps: true };
    }
    return finished;
  }

  private workerDone(event: WakeEvent): WakeResult {
    const run = this.runs.get(event.tenantId);
    this.wakeLog.append({
      kind: "worker_done",
      tenantId: event.tenantId,
      runId: run?.runId,
      at: nowIso(),
      detail: { workerId: event.workerId ?? run?.workerId },
    });
    this.workers.teardown(event.tenantId);
    this.opts.orchestrator.completeGoal(event.tenantId);
    const next = run
      ? this.runs.put({
          ...run,
          status: run.status === "denied" || run.status === "killed" ? run.status : "completed",
          pendingCardId: undefined,
          pendingEffect: undefined,
          updatedAt: nowIso(),
        })
      : undefined;
    const memory = this.injectMemory(event.tenantId, this.orchestratorId(event.tenantId));
    return {
      run: next,
      wokeOrchestrator: true,
      wokeOps: true,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  private kill(event: WakeEvent): WakeResult {
    const run = this.runs.get(event.tenantId);
    this.wakeLog.append({
      kind: "kill",
      tenantId: event.tenantId,
      runId: run?.runId,
      at: nowIso(),
      detail: { reason: event.reason ?? "kill" },
    });
    this.workers.teardown(event.tenantId);
    this.opts.orchestrator.completeGoal(event.tenantId);
    const next = run
      ? this.runs.put({
          ...run,
          status: "killed",
          pendingCardId: undefined,
          pendingEffect: undefined,
          updatedAt: nowIso(),
        })
      : undefined;
    const memory = this.injectMemory(event.tenantId, this.orchestratorId(event.tenantId));
    return {
      run: next,
      wokeOrchestrator: false,
      wokeOps: false,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  private finishAfterEffect(
    tenantId: string,
    proposed: { effect?: EffectResult; cardId?: string },
  ): WakeResult {
    const done = this.wake({ kind: "worker_done", tenantId });
    return {
      ...done,
      effect: proposed.effect,
      cardId: proposed.cardId,
    };
  }

  private admit(
    pack: LoadedPack,
    agent: AgentRecord,
    intent: CognitiveIntent,
  ): { effect?: EffectResult; cardId?: string } {
    const run = this.requireRun(pack.tenantId);
    try {
      const effect = this.opts.effects.execute({
        pack,
        agent,
        actionClass: intent.actionClass ?? "communicate",
        channel: intent.channel,
        purpose: intent.purpose,
        subject: intent.subject,
        surface: "field",
      });
      this.runs.put({
        ...run,
        status: "working",
        updatedAt: nowIso(),
      });
      return { effect };
    } catch (err) {
      if (err instanceof AuthorizationRequiredError) {
        this.runs.put({
          ...run,
          status: "awaiting_card",
          pendingCardId: err.cardId,
          pendingEffect: {
            actionClass: intent.actionClass ?? "communicate",
            channel: intent.channel ?? "unspecified",
            purpose: intent.purpose ?? "unspecified",
            subject: intent.subject ?? "unspecified",
            agentId: agent.agentId,
          },
          updatedAt: nowIso(),
        });
        return { cardId: err.cardId };
      }
      throw err;
    }
  }

  private validateTalking(intent: CognitiveIntent): void {
    if (intent.pass !== "talking") {
      throw new AvError("TALKING_PASS", "Talking pass must stay a talking pass");
    }
    if (intent.act === "propose_effect") {
      throw new AvError("TALKING_PASS", "Talking pass must not do heavy work");
    }
  }

  private injectMemory(tenantId: string, agentId: string): LabeledMemory {
    if (!this.opts.computerBaseDir) {
      return {
        profile: { label: "profile", agentId, body: null },
        logs: { label: "logs", agentId, entries: [] },
        recall: { label: "recall", scope: `agent:${agentId}`, items: [] },
      };
    }
    return this.memory.labeled(tenantId, agentId);
  }

  private assertLabeled(memory: LabeledMemory): void {
    if (memory.profile.label !== "profile" || memory.logs.label !== "logs" || memory.recall.label !== "recall") {
      throw new AvError("MEMORY_UNLABELED", "Memory that is not injected labeled is a diary and does not count");
    }
  }

  private requireRun(tenantId: string): RunRecord {
    const run = this.runs.get(tenantId);
    if (!run) throw new AvError("RUN_NOT_FOUND", "No habitat run on disk");
    return run;
  }

  private requireOrchestrator(tenantId: string): AgentRecord {
    const orch = this.opts.agents.list(tenantId).find((a) => a.isOrchestrator);
    if (!orch) throw new AvError("NOT_ORCHESTRATOR", "One orchestrator is required");
    return orch;
  }

  private orchestratorId(tenantId: string): string {
    return this.opts.agents.list(tenantId).find((a) => a.isOrchestrator)?.agentId ?? "ops";
  }

  private coderFromPending(tenantId: string, agentId: string): AgentRecord {
    return {
      agentId,
      tenantId,
      name: "coder",
      persona: "Thin coder: executor and branch on the tenant computer.",
      skills: ["executor", "branch"],
      specialties: ["coder"],
      isOrchestrator: false,
      createdAt: nowIso(),
    };
  }
}

function isTerminal(status: RunRecord["status"]): boolean {
  return status === "completed" || status === "denied" || status === "killed";
}

function defaultUntil(kind: WakeEvent["kind"]): "talking" | "card" | "done" {
  if (kind === "field_start") return "card";
  return "done";
}
