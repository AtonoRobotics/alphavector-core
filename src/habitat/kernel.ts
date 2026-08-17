import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentRecord } from "../agents/types.js";
import type { Orchestrator } from "../agents/orchestrator.js";
import type { AgentRuntime } from "../agents/runtime.js";
import type { CardBook } from "../auth/cards.js";
import { ComputerHost } from "../computer/host.js";
import { defaultImageCacheDir } from "../computer/image.js";
import { AuthorizationRequiredError, AvError, SurfaceViolationError } from "../errors.js";
import type { EffectExecutor, EffectResult } from "../effects/executor.js";
import { assertHabitatMayAsk, habitatAskReason } from "../grants/ask.js";
import type { GrantBook } from "../grants/store.js";
import type { HabitatAskReason } from "../grants/types.js";
import { newId, nowIso } from "../ids.js";
import type { ActionCeiling, LoadedPack } from "../packs/types.js";
import { readTenantAdapterBind } from "./adapter-bind.js";
import { readTenantAdapterCredentials } from "./adapter-credentials.js";
import { DeepAgentsAdapter } from "./deep-agents.js";
import { HabitatMemoryStore } from "./memory-store.js";
import {
  appendMail,
  findStoredMail,
  mailFile,
  readTenantMail,
  saveMailStore,
  type HabitatMailItem,
} from "./mail-store.js";
import {
  findStoredRoutine,
  isRoutineDue,
  readTenantRoutines,
  routinesFile,
  saveRoutineStore,
  upsertRoutine,
  type RoutineRecord,
} from "./routine-store.js";
import {
  deadlinesFile,
  findStoredDeadline,
  isDeadlineDue,
  readTenantDeadlines,
  saveDeadlineStore,
  upsertDeadline,
  type DeadlineRecord,
} from "./deadline-store.js";
import {
  findStoredConnectorBind,
  readTenantConnectorBinds,
  type ConnectorBindRecord,
} from "./connector-bind.js";
import {
  findStoredConnectorCredentials,
  readTenantConnectorCredentials,
} from "./connector-credentials.js";
import { connectorSendFields, invokeConnectorWorld } from "./connector-world.js";
import { RunStore } from "./run-store.js";
import { writeProposalFile } from "./proposals.js";
import { loadSkillFiles } from "./skills.js";
import { stem } from "./stem.js";
import {
  CODER_TYPE,
  HABITAT_OWNED,
  type AdapterBind,
  type AdapterCredentials,
  type CognitiveAdapter,
  type CognitiveIntent,
  type LabeledMemory,
  type HabitatIsolationRecord,
  type ProposalFile,
  type ProposalKind,
  KERNEL_RUN_BUDGET,
  type RunRecord,
  type SkillFile,
  type WakeEvent,
  type WakeResult,
  type WorkerRecord,
} from "./types.js";
import { WakeBus } from "./wake-bus.js";
import { recordWake, replayWakeLog, replayWakeLogFromDisk, WakeLog, wakeTarget } from "./wake-log.js";
import { WorkerBook } from "./worker.js";

/** Core-owned due interval. Not field-configured. Not Temporal (DEC-020). */
export const HABITAT_ROUTINE_TICK_MS = 60_000;

export interface HabitatKernelOptions {
  computerBaseDir?: string;
  /** Already-created tenant computer. Product boot attaches this. */
  computer?: ComputerHost;
  /** Alpine image cache. Ops/env, not a field control. */
  imageCacheDir?: string;
  cards: CardBook;
  grants: GrantBook;
  effects: EffectExecutor;
  agents: AgentRuntime;
  orchestrator: Orchestrator;
  adapter?: CognitiveAdapter;
  /** Injectable clock. Tests advance this; the product process uses wall time. */
  now?: () => string;
  /** Test override of HABITAT_ROUTINE_TICK_MS. Not a field schedule string. */
  tickMs?: number;
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
  private readonly nowFn: () => string;
  private readonly tickMs: number;
  private frozenNow?: string;
  private timer?: ReturnType<typeof setInterval>;
  private computer?: ComputerHost;
  /** Tenants whose worker teardown is expected (done / fail / kill). Not a crash. */
  private readonly expectedTeardown = new Set<string>();
  /**
   * In-flight pass context. Nested wake() from the same pass (worker_done after
   * an effect) dispatches now. An external wake for that tenant queues (HK-013).
   */
  private readonly passAls = new AsyncLocalStorage<{ tenantId: string }>();
  /** Per-tenant arrival chain. The next wake runs after the in-flight pass. */
  private readonly passTail = new Map<string, Promise<void>>();

  constructor(private readonly opts: HabitatKernelOptions) {
    this.runs = new RunStore(opts.computerBaseDir);
    this.wakeLog = new WakeLog(opts.computerBaseDir);
    this.workers = new WorkerBook(opts.computerBaseDir, opts.computer);
    this.memory = new HabitatMemoryStore(opts.computerBaseDir);
    this.adapter = opts.adapter ?? new DeepAgentsAdapter();
    this.nowFn = opts.now ?? nowIso;
    this.tickMs = Number.isFinite(opts.tickMs) && (opts.tickMs as number) > 0 ? (opts.tickMs as number) : HABITAT_ROUTINE_TICK_MS;
    if (opts.computer) this.computer = opts.computer;
  }

  attachComputer(computer: ComputerHost): void {
    this.computer = computer;
    this.workers.attachComputer(computer);
  }

  /** Adapter name the kernel is running. DryStem is fixture-only; not a deploy. */
  cognitiveAdapterName(): string {
    return this.adapter.name;
  }

  /**
   * One persistent Linux computer per tenant. Starts if needed. Packs do not own it.
   * Field does not configure the machine.
   */
  async ensureComputer(tenantId: string): Promise<ComputerHost> {
    if (!this.opts.computerBaseDir) {
      throw new AvError("WORKER_COMPUTER_REQUIRED", "Workers run on the tenant computer");
    }
    if (!this.computer) {
      this.computer = await ComputerHost.create({
        baseDir: this.opts.computerBaseDir,
        imageCacheDir: this.opts.imageCacheDir ?? defaultImageCacheDir(),
      });
      this.workers.attachComputer(this.computer);
    }
    const status = await this.computer.driver.status(tenantId);
    if (status?.status !== "running") {
      await this.computer.start(tenantId);
    }
    return this.computer;
  }

  /** Kernel-owned clock. Ticker and fireDue read this; field does not set it. */
  now(): string {
    return this.frozenNow ?? this.nowFn();
  }

  /**
   * Advance the kernel-owned clock and run the due ticker.
   * Tests use this instead of calling fireDue.
   */
  async advanceClock(iso: string): Promise<void> {
    this.frozenNow = iso;
    await this.tickDueAsync();
  }

  /** Remember the loaded pack so the ticker can fireDue without a test passing pack. */
  setPack(tenantId: string, pack: LoadedPack): void {
    this.packs.set(tenantId, pack);
  }

  /**
   * Start the habitat-owned due ticker. Interval is core-owned, not field-set.
   * Product process (bootFieldCore / field-serve) starts this after the pack is adopted.
   * First tick is immediate so a due routine already on disk wakes without waiting.
   */
  startDueTicker(): void {
    if (this.timer || !this.opts.computerBaseDir) return;
    this.tickDue();
    this.timer = setInterval(() => this.tickDue(), this.tickMs);
    this.timer.unref?.();
  }

  /** Clear the due timer. Field HTTP close and process shutdown call this. */
  stopDueTicker(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  getRun(tenantId: string): RunRecord | undefined {
    return this.runs.get(tenantId);
  }

  /**
   * Open (non-terminal) runs. One tenant, one goal: 0 or 1.
   * Terminal completed/denied/killed runs are not sitting in the firm.
   */
  openRuns(tenantId: string): RunRecord[] {
    const run = this.runs.get(tenantId);
    if (!run || isTerminal(run.status)) return [];
    return [run];
  }

  listWakes(tenantId: string): ReturnType<WakeLog["list"]> {
    return this.wakeLog.list(tenantId);
  }

  /** Persist an immutable HK-014 wake record. Do not write a wake without a run. */
  private appendWake(
    event: WakeEvent,
    decision: ReturnType<typeof stem>,
    runId: string | undefined,
    detail?: Record<string, unknown>,
  ): void {
    if (!runId) return;
    this.wakeLog.append(
      recordWake({
        kind: event.kind,
        tenantId: event.tenantId,
        run: runId,
        target: wakeTarget(event, decision),
        decision,
        detail,
      }),
    );
  }

  activeWorker(tenantId: string): WorkerRecord | undefined {
    return this.workers.get(tenantId);
  }

  /** Booked workers on this tenant. 0 or 1. Leftover trailer without a book is not a worker. */
  listWorkers(tenantId: string): WorkerRecord[] {
    const worker = this.workers.get(tenantId);
    return worker ? [worker] : [];
  }

  /**
   * Trailer isolation as a record. Habitat isolation is trailer.
   * `exists` is the directory; `live` is the booked pid.
   * A read. Does not emit worker_failed. Does not relaunch.
   */
  isolation(tenantId: string): HabitatIsolationRecord {
    const worker = this.workers.get(tenantId);
    return {
      isolation: "trailer",
      ...(worker?.workerId ? { workerId: worker.workerId } : {}),
      ...(worker?.trailerPath ? { trailerPath: worker.trailerPath } : {}),
      exists: this.workers.trailerExists(tenantId),
      live: this.workers.isLive(tenantId),
    };
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
   * Field journey start: the product wake. Holds the coder child (live pid).
   * Same as `HabitatKernel.wake({ kind: "field_start" }, { holdWorker: true })`.
   * Creates or resumes the run, injects labeled memory, and launches the thin
   * coder (executor + branch, trailer isolation). Talking stays thin.
   * A second start with the same goal is follow-up (same worker / same run).
   * A second start with a different goal throws ONE_GOAL — one tenant, one
   * pack, one orchestrator, one goal. Same fail-closed rule as `wake()`.
   */
  async observeFieldStart(event: Omit<WakeEvent, "kind"> & { pack: LoadedPack; goal: string }): Promise<WakeResult> {
    this.packs.set(event.tenantId, event.pack);
    return this.wake({ ...event, kind: "field_start" }, { holdWorker: true });
  }

  /**
   * Kill short-circuits first (HK-060). Any other wake that arrives during an
   * in-flight talking/worker pass queues and drains in arrival order (HK-013).
   * Nested wake() from the same pass still dispatches now (stem / admission).
   */
  async wake(event: WakeEvent, opts?: { until?: "talking" | "card" | "done"; holdWorker?: boolean }): Promise<WakeResult> {
    this.bus.emit(event);
    if (event.pack) this.packs.set(event.tenantId, event.pack);
    this.assertFieldCannotSetRunKernel(event);

    if (event.kind === "kill") {
      return this.kill(event);
    }
    if (this.passAls.getStore()?.tenantId === event.tenantId) {
      return this.dispatchWake(event, opts);
    }
    return this.serializeWake(event, opts);
  }

  /**
   * Queue behind the in-flight pass. Each item is a real kernel wake — not dropped,
   * not a new kind. Previous-pass failure still drains the rest.
   */
  private serializeWake(
    event: WakeEvent,
    opts: { until?: "talking" | "card" | "done"; holdWorker?: boolean } | undefined,
  ): Promise<WakeResult> {
    const tenantId = event.tenantId;
    const prev = this.passTail.get(tenantId) ?? Promise.resolve();
    const result = prev
      .catch(() => undefined)
      .then(() => this.passAls.run({ tenantId }, () => this.dispatchWake(event, opts)));
    this.passTail.set(
      tenantId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private async dispatchWake(
    event: WakeEvent,
    opts?: { until?: "talking" | "card" | "done"; holdWorker?: boolean },
  ): Promise<WakeResult> {
    const pack = event.pack ?? this.packs.get(event.tenantId);
    const decision = stem(event);
    const until = opts?.until ?? defaultUntil(event.kind);

    if (event.kind === "card_decide") {
      return this.cardDecide(event, pack, until);
    }
    if (event.kind === "worker_done") {
      return this.workerDone(event, opts?.holdWorker === true);
    }
    if (event.kind === "worker_failed") {
      return this.workerFailed(event);
    }
    if (event.kind === "architect_message") {
      return this.architectMessageWake(event, decision);
    }
    if (event.kind === "field_ask") {
      return this.fieldAsk(event, decision);
    }
    if (event.kind === "field_continue") {
      return this.fieldContinue(event, decision, opts?.holdWorker === true);
    }
    if (event.kind === "routine") {
      return this.routineWake(event, pack, decision, until, opts?.holdWorker === true);
    }
    if (event.kind === "mail") {
      return this.mailWake(event, decision);
    }
    if (event.kind === "deadline") {
      return this.deadlineWake(event, decision);
    }
    if (event.kind === "connector") {
      return this.connectorWake(event, decision);
    }
    if (event.kind !== "field_start") {
      const memory = this.injectMemory(event.tenantId, this.orchestratorId(event.tenantId));
      this.appendWake(event, decision, this.runs.get(event.tenantId)?.runId, { typedOnly: true } as { typedOnly: true });
      // detail: { typedOnly: true } — typed-only fallback; closed kinds have their own append.
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

  /**
   * Kill already took effect (HK-060). Stop the in-flight pass from un-killing
   * the run or launching another coder. Tear down a worker launched after kill.
   */
  private ifKilled(tenantId: string): WakeResult | undefined {
    const run = this.runs.get(tenantId);
    if (run?.status !== "killed") return undefined;
    this.expectedTeardown.add(tenantId);
    try {
      this.workers.teardown(tenantId);
    } finally {
      this.expectedTeardown.delete(tenantId);
    }
    return {
      run,
      wokeOrchestrator: false,
      wokeOps: false,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory: this.injectMemory(tenantId, this.orchestratorId(tenantId)),
    };
  }

  /**
   * Fire stored routines that are due. Reads tenants/{id}/routines.json only.
   * Pack declaration is not live. Missing file is empty (no invent).
   * Corrupt store fails closed. Each due routine calls wake({ kind: "routine" }).
   * Not a workflow-engine bus and not field-configured.
   */
  async fireDue(tenantId: string, opts?: { now?: string; holdWorker?: boolean; pack?: LoadedPack }): Promise<WakeResult[]> {
    const store = readTenantRoutines(this.opts.computerBaseDir, tenantId);
    const now = opts?.now ?? this.now();
    const pack = opts?.pack ?? this.packs.get(tenantId);
    const due = store.routines.filter((row) => row.tenantId === tenantId && isRoutineDue(row, now));
    const results: WakeResult[] = [];
    let next = store;
    for (const routine of due) {
      const result = await this.wake(
        {
          kind: "routine",
          tenantId,
          pack,
          goal: routine.goal,
          routineId: routine.routineId,
          journeyId: routine.journeyId,
          recordId: routine.recordId,
        },
        { holdWorker: opts?.holdWorker !== false },
      );
      next = upsertRoutine(next, { ...routine, lastFiredAt: now });
      if (this.opts.computerBaseDir) {
        saveRoutineStore(routinesFile(this.opts.computerBaseDir, tenantId), next);
      }
      results.push(result);
    }
    return results;
  }

  /**
   * Product ticker body. Habitat owns this clock. Calls fireDue (routines),
   * fireDueDeadlines, and reapCrashedWorkers per tenant. Same clock — not a
   * second Temporal-like bus. isolation() is a read and does not reap.
   * Typed fail (ONE_GOAL, ADAPTER_UNBOUND, NO_OPEN_RUN, *_STORE_CORRUPT, ...) is
   * swallowed so the interval keeps ticking. Does not invent routines or deadlines.
   */
  private tickDue(): void {
    void this.tickDueAsync();
  }

  private async tickDueAsync(): Promise<void> {
    if (!this.opts.computerBaseDir) return;
    const now = this.now();
    for (const tenantId of this.tickerTenantIds()) {
      try {
        await this.fireDue(tenantId, { now });
      } catch {
        // keep ticking
      }
      try {
        await this.fireDueDeadlines(tenantId, { now });
      } catch {
        // keep ticking
      }
      try {
        await this.reapCrashedWorkers(tenantId);
      } catch {
        // keep ticking
      }
    }
  }

  /**
   * Held coder pid died in this process. Emit worker_failed and wake the
   * orchestrator. Not worker_done. Not kill. isolation() does not call this.
   * A booked dead pid after restart (not held by this WorkerBook instance) is
   * not a crash — field_start + awaiting_card may relaunch that workerId.
   */
  private async reapCrashedWorkers(tenantId: string): Promise<void> {
    if (this.expectedTeardown.has(tenantId)) return;
    const worker = this.workers.get(tenantId);
    if (!worker?.pid || !this.workers.isHeldHere(tenantId)) return;
    if (this.workers.isLive(tenantId)) return;
    await this.reportWorkerFailed({
      tenantId,
      workerId: worker.workerId,
      reason: "worker_exited",
    });
  }

  /**
   * Fire stored deadlines that are due. Reads tenants/{id}/deadlines.json only.
   * Missing file is empty (no invent). Corrupt store fails closed.
   * Each due deadline calls wake({ kind: "deadline" }). Kernel-owned; not Temporal.
   * Called from tickDue / advanceClock — not a field-configured bus.
   */
  private async fireDueDeadlines(tenantId: string, opts?: { now?: string }): Promise<void> {
    const store = readTenantDeadlines(this.opts.computerBaseDir, tenantId);
    const now = opts?.now ?? this.now();
    const due = store.deadlines.filter((row) => row.tenantId === tenantId && isDeadlineDue(row, now));
    let next = store;
    for (const deadline of due) {
      await this.wake({
        kind: "deadline",
        tenantId,
        pack: this.packs.get(tenantId),
        deadlineId: deadline.deadlineId,
        runId: this.runs.get(tenantId)?.runId,
      });
      next = upsertDeadline(next, { ...deadline, lastFiredAt: now });
      if (this.opts.computerBaseDir) {
        saveDeadlineStore(deadlinesFile(this.opts.computerBaseDir, tenantId), next);
      }
    }
  }

  private tickerTenantIds(): string[] {
    const ids = new Set(this.packs.keys());
    const root = path.join(this.opts.computerBaseDir ?? "", "tenants");
    if (this.opts.computerBaseDir && existsSync(root)) {
      for (const name of readdirSync(root)) {
        try {
          if (statSync(path.join(root, name)).isDirectory()) ids.add(name);
        } catch {
          // skip unreadable entries
        }
      }
    }
    return [...ids];
  }

  replay(tenantId: string): ReturnType<typeof replayWakeLog> {
    if (this.opts.computerBaseDir) {
      return replayWakeLogFromDisk(this.opts.computerBaseDir, tenantId);
    }
    const run = this.runs.get(tenantId);
    return replayWakeLog(this.wakeLog.list(tenantId), { runs: run ? [run] : [] });
  }

  /**
   * Due routine: load the stored routine (do not invent), inject labeled memory,
   * attach to the open run or start one goal if none is open. ONE_GOAL if the
   * routine's goal is distinct from the open run.
   */
  private async routineWake(
    event: WakeEvent,
    pack: LoadedPack | undefined,
    decision: ReturnType<typeof stem>,
    until: "talking" | "card" | "done",
    holdWorker: boolean,
  ): Promise<WakeResult> {
    const stored = this.requireStoredRoutine(event);
    const goal = event.goal ?? stored.goal;
    const existing = this.runs.get(event.tenantId);
    if (existing && !isTerminal(existing.status)) {
      if (goal !== existing.goal) {
        throw new AvError("ONE_GOAL", "Orchestrator SHALL dispatch one goal at a time");
      }
      return this.attachRoutine(event, stored, existing, decision);
    }
    return this.fieldStart(
      { ...event, kind: "routine", goal, journeyId: event.journeyId ?? stored.journeyId, recordId: event.recordId ?? stored.recordId },
      pack,
      decision,
      until,
      holdWorker,
    );
  }

  private async attachRoutine(
    event: WakeEvent,
    stored: RoutineRecord,
    run: RunRecord,
    decision: ReturnType<typeof stem>,
  ): Promise<WakeResult> {
    const creature = this.requireOrchestrator(event.tenantId);
    const memory = this.injectMemory(event.tenantId, creature.agentId);
    this.assertLabeled(memory);
    const resolved = this.requireThinkBind(event.tenantId, event.pack ?? this.packs.get(event.tenantId));
    const skills = this.injectSkills(event.tenantId);
    const talking = await this.adapter.think({
      pass: "talking",
      event,
      run,
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    this.validateTalking(talking);
    this.appendWake(event, decision, run.runId, { routineId: stored.routineId, attached: true });
    return {
      run,
      wokeOrchestrator: decision.wakeOrchestrator,
      wokeOps: decision.wakeOps,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  private requireStoredRoutine(event: WakeEvent): RoutineRecord {
    const routineId = event.routineId?.trim();
    if (!routineId) {
      throw new AvError("ROUTINE_STORE_MISSING", "Routine wake requires a stored routine; refusing to invent");
    }
    const store = readTenantRoutines(this.opts.computerBaseDir, event.tenantId);
    const found = findStoredRoutine(store, event.tenantId, routineId);
    if (!found) {
      throw new AvError("ROUTINE_STORE_MISSING", "Routine is not stored on the tenant computer; refusing to invent");
    }
    return found;
  }

  /**
   * Deliver inter-agent mail (CS-018). Writes tenants/{id}/mail.json, then
   * wake({ kind: "mail" }). Requires an existing addressee. Habitat path
   * requires an existing sender agent. Architect path is gated separately.
   * Mail SHALL NOT confer authority. Attach only — no second goal, no coder.
   */
  async deliverMail(input: {
    tenantId: string;
    addresseeId: string;
    fromAgentId: string;
    body: string;
    deliveredBy: "architect" | "habitat";
  }): Promise<WakeResult> {
    const addresseeId = input.addresseeId.trim();
    const fromAgentId = input.fromAgentId.trim();
    if (!addresseeId) {
      throw new AvError("AGENT_NOT_FOUND", "Mail requires an existing addressee");
    }
    if (!fromAgentId) {
      throw new AvError("AGENT_NOT_FOUND", "Mail requires an existing sender; refusing to forge");
    }
    if (fromAgentId === addresseeId) {
      throw new AvError("MAIL_INVALID", "Agent cannot mail itself as an authority channel");
    }
    this.requireAddressee(input.tenantId, addresseeId);
    if (input.deliveredBy === "architect") {
      if (fromAgentId !== "architect") {
        throw new AvError("MAIL_INVALID", "Architect mail cannot impersonate another agent");
      }
    } else {
      this.requireExistingAgent(input.tenantId, fromAgentId);
    }
    readTenantMail(this.opts.computerBaseDir, input.tenantId);
    const run = this.runs.get(input.tenantId);
    if (!run || isTerminal(run.status)) {
      throw new AvError("NO_OPEN_RUN", "Mail requires an open run; no implicit start");
    }
    const item = this.writeMailItem({
      tenantId: input.tenantId,
      fromAgentId,
      toAgentId: addresseeId,
      body: input.body,
    });
    return this.wake({
      kind: "mail",
      tenantId: input.tenantId,
      pack: this.packs.get(input.tenantId),
      addresseeId,
      fromAgentId,
      mailId: item.mailId,
      runId: run.runId,
    });
  }

  /**
   * Mail: a wake on the open run for the addressee. Does not mint a run or a goal.
   * Talking stays thin — no pickAgent, no coder launch. No implicit start.
   * Mail SHALL NOT confer authority.
   */
  private async mailWake(event: WakeEvent, decision: ReturnType<typeof stem>): Promise<WakeResult> {
    const stored = this.requireStoredMail(event);
    const addresseeId = event.addresseeId?.trim() || stored.toAgentId;
    this.requireAddressee(event.tenantId, addresseeId);
    if (addresseeId !== stored.toAgentId) {
      throw new AvError("MAIL_INVALID", "Mail addressee does not match the stored item");
    }
    const run = this.runs.get(event.tenantId);
    if (!run || isTerminal(run.status)) {
      throw new AvError("NO_OPEN_RUN", "Mail requires an open run; no implicit start");
    }
    const memory = this.injectMemory(event.tenantId, addresseeId);
    this.assertLabeled(memory);
    const resolved = this.requireThinkBind(event.tenantId, this.packs.get(event.tenantId));
    const skills = this.injectSkills(event.tenantId);
    const talking = await this.adapter.think({
      pass: "talking",
      event,
      run,
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    this.validateTalking(talking);
    this.appendWake(event, decision, run.runId, {
      mailId: stored.mailId,
      addresseeId,
      attached: true,
      confersAuthority: false,
    });
    return {
      run,
      wokeOrchestrator: decision.wakeOrchestrator,
      wokeOps: decision.wakeOps,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  private writeMailItem(input: {
    tenantId: string;
    fromAgentId: string;
    toAgentId: string;
    body: string;
  }): HabitatMailItem {
    if (!this.opts.computerBaseDir) {
      throw new AvError("MAIL_STORE_MISSING", "Mail store is missing; refusing to invent mail");
    }
    const store = readTenantMail(this.opts.computerBaseDir, input.tenantId);
    const item: HabitatMailItem = {
      mailId: newId("mail"),
      tenantId: input.tenantId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      body: input.body,
      createdAt: nowIso(),
      confersAuthority: false,
    };
    saveMailStore(mailFile(this.opts.computerBaseDir, input.tenantId), appendMail(store, item));
    return item;
  }

  private requireStoredMail(event: WakeEvent): HabitatMailItem {
    const mailId = event.mailId?.trim();
    if (!mailId) {
      throw new AvError("MAIL_STORE_MISSING", "Mail wake requires a stored mail item; refusing to invent");
    }
    const store = readTenantMail(this.opts.computerBaseDir, event.tenantId);
    const found = findStoredMail(store, event.tenantId, mailId);
    if (!found) {
      throw new AvError("MAIL_STORE_MISSING", "Mail is not stored on the tenant computer; refusing to invent");
    }
    return found;
  }

  /**
   * Deadline: a wake on the open run. Does not mint a run or a goal.
   * Talking stays thin — no pickAgent, no coder launch. No implicit start
   * (unlike routine, which may start one goal). Attach only, like mail / field_ask.
   */
  private async deadlineWake(event: WakeEvent, decision: ReturnType<typeof stem>): Promise<WakeResult> {
    const stored = this.requireStoredDeadline(event);
    const run = this.runs.get(event.tenantId);
    if (!run || isTerminal(run.status)) {
      throw new AvError("NO_OPEN_RUN", "Deadline requires an open run; no implicit start");
    }
    const creature = this.requireOrchestrator(event.tenantId);
    const memory = this.injectMemory(event.tenantId, creature.agentId);
    this.assertLabeled(memory);
    const resolved = this.requireThinkBind(event.tenantId, this.packs.get(event.tenantId));
    const skills = this.injectSkills(event.tenantId);
    const talking = await this.adapter.think({
      pass: "talking",
      event,
      run,
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    this.validateTalking(talking);
    this.appendWake(event, decision, run.runId, { deadlineId: stored.deadlineId, attached: true });
    return {
      run,
      wokeOrchestrator: decision.wakeOrchestrator,
      wokeOps: decision.wakeOps,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  /**
   * Admit a connector event (DEC-020). Requires an Architect bind on
   * tenants/{id}/connector-bind.json. In-process ConnectorBook is not this store.
   * Attach only — no second goal, no coder. Connector SHALL NOT confer authority.
   * Temporal is not the bus.
   */
  async deliverConnectorEvent(input: {
    tenantId: string;
    connectorId: string;
  }): Promise<WakeResult> {
    return this.admitConnector(input);
  }

  /**
   * Same as deliverConnectorEvent. Architect bind, then wake({ kind: "connector" }).
   * Unbound → CONNECTOR_UNBOUND. Missing required creds → CONNECTOR_CREDENTIALS_MISSING.
   * No open run → NO_OPEN_RUN. Does not mint a run or a goal.
   */
  async admitConnector(input: { tenantId: string; connectorId: string }): Promise<WakeResult> {
    const connectorId = input.connectorId.trim();
    if (!connectorId) {
      throw new AvError("CONNECTOR_UNBOUND", "Connector admit requires an Architect bind; refusing to invent");
    }
    this.requireConnectorBind(input.tenantId, connectorId);
    const run = this.runs.get(input.tenantId);
    if (!run || isTerminal(run.status)) {
      throw new AvError("NO_OPEN_RUN", "Connector requires an open run; no implicit start");
    }
    return this.wake({
      kind: "connector",
      tenantId: input.tenantId,
      pack: this.packs.get(input.tenantId),
      connectorId,
      runId: run.runId,
    });
  }

  /**
   * Connector: a wake on the open run. Does not mint a run or a goal.
   * Talking stays thin — no pickAgent, no coder launch. No implicit start
   * (unlike routine, which may start one goal). Attach only, like mail / deadline.
   * Connector SHALL NOT confer authority.
   */
  private async connectorWake(event: WakeEvent, decision: ReturnType<typeof stem>): Promise<WakeResult> {
    const stored = this.requireConnectorBind(event.tenantId, event.connectorId);
    const run = this.runs.get(event.tenantId);
    if (!run || isTerminal(run.status)) {
      throw new AvError("NO_OPEN_RUN", "Connector requires an open run; no implicit start");
    }
    const creature = this.requireOrchestrator(event.tenantId);
    const memory = this.injectMemory(event.tenantId, creature.agentId);
    this.assertLabeled(memory);
    const resolved = this.requireThinkBind(event.tenantId, this.packs.get(event.tenantId));
    const skills = this.injectSkills(event.tenantId);
    const talking = await this.adapter.think({
      pass: "talking",
      event,
      run,
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    this.validateTalking(talking);
    this.appendWake(event, decision, run.runId, {
      connectorId: stored.connectorId,
      attached: true,
      confersAuthority: false,
    });
    return {
      run,
      wokeOrchestrator: decision.wakeOrchestrator,
      wokeOps: decision.wakeOps,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  private requireConnectorBind(tenantId: string, connectorId: string | undefined): ConnectorBindRecord {
    const id = connectorId?.trim();
    if (!id) {
      throw new AvError("CONNECTOR_UNBOUND", "Connector wake requires an Architect bind; refusing to invent");
    }
    const store = readTenantConnectorBinds(this.opts.computerBaseDir, tenantId);
    const found = findStoredConnectorBind(store, tenantId, id);
    if (!found) {
      throw new AvError("CONNECTOR_UNBOUND", "Architect must bind the connector before admit; no silent no-op");
    }
    if (found.requiresCredentials) {
      const creds = readTenantConnectorCredentials(this.opts.computerBaseDir, tenantId);
      const secret = findStoredConnectorCredentials(creds, tenantId, id);
      if (!secret) {
        throw new AvError("CONNECTOR_CREDENTIALS_MISSING", "Architect must write connector credentials before admit; no silent no-op");
      }
    }
    return found;
  }

  private requireStoredDeadline(event: WakeEvent): DeadlineRecord {
    const deadlineId = event.deadlineId?.trim();
    if (!deadlineId) {
      throw new AvError("DEADLINE_STORE_MISSING", "Deadline wake requires a stored deadline; refusing to invent");
    }
    const store = readTenantDeadlines(this.opts.computerBaseDir, event.tenantId);
    const found = findStoredDeadline(store, event.tenantId, deadlineId);
    if (!found) {
      throw new AvError("DEADLINE_STORE_MISSING", "Deadline is not stored on the tenant computer; refusing to invent");
    }
    return found;
  }

  private requireAddressee(tenantId: string, addresseeId: string): void {
    this.requireExistingAgent(tenantId, addresseeId);
  }

  private requireExistingAgent(tenantId: string, agentId: string): void {
    this.requireExistingAgentRecord(tenantId, agentId);
  }

  private requireExistingAgentRecord(tenantId: string, agentId: string): AgentRecord {
    const found = this.opts.agents.list(tenantId).find((a) => a.agentId === agentId);
    if (!found) {
      throw new AvError("AGENT_NOT_FOUND", "Requires an existing agent; refusing to invent or impersonate");
    }
    return found;
  }

  /**
   * Field continue: a wake on the open run. Does not mint a run or a goal.
   * Field SHALL NOT pick who works — no agent id, worker type, or assignee.
   * Talking stays thin unless the orchestrator decides launch_worker.
   * Continue is a wake, not a conductor.
   */
  private async fieldContinue(
    event: WakeEvent,
    decision: ReturnType<typeof stem>,
    holdWorker: boolean,
  ): Promise<WakeResult> {
    this.assertFieldCannotPickAgent(event);
    const run = this.runs.get(event.tenantId);
    if (!run || isTerminal(run.status)) {
      throw new AvError("NO_OPEN_RUN", "Continue requires an open run; no implicit start");
    }
    const creature = this.requireOrchestrator(event.tenantId);
    const memory = this.injectMemory(event.tenantId, creature.agentId);
    this.assertLabeled(memory);
    const pack = event.pack ?? this.packs.get(event.tenantId);
    const resolved = this.requireThinkBind(event.tenantId, pack);
    const skills = this.injectSkills(event.tenantId);
    const talking = await this.adapter.think({
      pass: "talking",
      event,
      run,
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    this.validateTalking(talking);
    this.appendWake(event, decision, run.runId, { wakeOnly: true });
    if (talking.act === "launch_worker" && pack && !this.workers.isLive(event.tenantId)) {
      this.putRun({
        ...run,
        pendingIntent: "launch_worker",
        updatedAt: nowIso(),
      });
      return this.actLaunchAndWork(event, pack, creature, skills, holdWorker, "card");
    }
    return {
      run,
      wokeOrchestrator: decision.wakeOrchestrator,
      wokeOps: decision.wakeOps,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  /**
   * Architect message (HK-011). Kernel wake, not sit(). Loads the orchestrator,
   * or the addressed role-agent when addresseeId is present. Unknown addressee
   * fails closed — not a silent no-op. Attach only; no implicit start.
   * Product entry is architectDeliverMessage (Architect credential). Field cannot forge it.
   */
  async deliverArchitectMessage(input: {
    tenantId: string;
    body: string;
    addresseeId?: string;
  }): Promise<WakeResult> {
    const run = this.runs.get(input.tenantId);
    if (!run || isTerminal(run.status)) {
      throw new AvError("NO_OPEN_RUN", "Architect message requires an open run; no implicit start");
    }
    const addresseeId = input.addresseeId?.trim();
    if (addresseeId) {
      this.requireExistingAgent(input.tenantId, addresseeId);
    }
    return this.wake({
      kind: "architect_message",
      tenantId: input.tenantId,
      pack: this.packs.get(input.tenantId),
      addresseeId: addresseeId || undefined,
      fromAgentId: "architect",
      goal: input.body,
      runId: run.runId,
    });
  }

  /**
   * Worker failure (HK-011). Typed wake, not worker_done, not an untyped error.
   * Tears the failed trailer down and wakes the orchestrator. Does not complete
   * the goal and does not record worker_done.
   */
  async reportWorkerFailed(input: {
    tenantId: string;
    workerId?: string;
    reason?: string;
  }): Promise<WakeResult> {
    const run = this.runs.get(input.tenantId);
    this.expectedTeardown.add(input.tenantId);
    try {
      return await this.wake({
        kind: "worker_failed",
        tenantId: input.tenantId,
        pack: this.packs.get(input.tenantId),
        workerId: input.workerId ?? run?.workerId,
        reason: input.reason,
        runId: run?.runId,
      });
    } finally {
      this.expectedTeardown.delete(input.tenantId);
    }
  }

  /**
   * Architect message: a wake on the open run. Does not mint a run or a goal.
   * No addressee → load the orchestrator. Addressee present → load that
   * role-agent. Talking stays thin — no pickAgent, no coder launch.
   */
  private async architectMessageWake(
    event: WakeEvent,
    decision: ReturnType<typeof stem>,
  ): Promise<WakeResult> {
    const run = this.runs.get(event.tenantId);
    if (!run || isTerminal(run.status)) {
      throw new AvError("NO_OPEN_RUN", "Architect message requires an open run; no implicit start");
    }
    const addresseeId = event.addresseeId?.trim();
    const loaded =
      addresseeId
        ? this.requireExistingAgentRecord(event.tenantId, addresseeId)
        : this.requireOrchestrator(event.tenantId);
    const memory = this.injectMemory(event.tenantId, loaded.agentId);
    this.assertLabeled(memory);
    const resolved = this.requireThinkBind(event.tenantId, this.packs.get(event.tenantId));
    const skills = this.injectSkills(event.tenantId);
    const talking = await this.adapter.think({
      pass: "talking",
      event,
      run,
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    this.validateTalking(talking);
    this.appendWake(event, decision, run.runId, {
      fromAgentId: "architect",
      loadedAgentId: loaded.agentId,
      ...(addresseeId ? { addresseeId } : {}),
    });
    return {
      run,
      wokeOrchestrator: decision.wakeOrchestrator,
      wokeOps: decision.wakeOps,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  /**
   * Worker failed: tear the trailer down, then wake the orchestrator.
   * Not worker_done. Does not complete the goal. Talking stays thin.
   */
  private async workerFailed(event: WakeEvent): Promise<WakeResult> {
    const run = this.runs.get(event.tenantId);
    const decision = stem(event);
    this.appendWake(event, decision, run?.runId, {
      workerId: event.workerId ?? run?.workerId,
      reason: event.reason ?? "worker_failed",
    });
    this.expectedTeardown.add(event.tenantId);
    try {
      this.workers.teardown(event.tenantId);
    } finally {
      this.expectedTeardown.delete(event.tenantId);
    }

    if (!run || isTerminal(run.status)) {
      const memory = this.injectMemory(event.tenantId, this.orchestratorId(event.tenantId));
      return {
        run,
        wokeOrchestrator: decision.wakeOrchestrator,
        wokeOps: decision.wakeOps,
        launchedWorker: false,
        talkingDidHeavyWork: false,
        memory,
      };
    }

    const open = this.putRun({
      ...run,
      status: "talking",
      pendingCardId: undefined,
      pendingEffect: undefined,
      pendingIntent: undefined,
      updatedAt: nowIso(),
    });
    const orch = this.requireOrchestrator(event.tenantId);
    const memory = this.injectMemory(event.tenantId, orch.agentId);
    this.assertLabeled(memory);
    const pack = event.pack ?? this.packs.get(event.tenantId);
    const resolved = this.requireThinkBind(event.tenantId, pack);
    const skills = this.injectSkills(event.tenantId);
    const talking = await this.adapter.think({
      pass: "talking",
      event,
      run: open,
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    this.validateTalking(talking);
    return {
      run: open,
      wokeOrchestrator: decision.wakeOrchestrator,
      wokeOps: decision.wakeOps,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  /**
   * Field ask: a wake on the open run. Does not mint a run or a goal.
   * Talking stays thin — no pickAgent, no coder launch. No implicit start.
   */
  private async fieldAsk(event: WakeEvent, decision: ReturnType<typeof stem>): Promise<WakeResult> {
    const run = this.runs.get(event.tenantId);
    if (!run || isTerminal(run.status)) {
      throw new AvError("NO_OPEN_RUN", "Ask requires an open run; no implicit start");
    }
    const creature = this.requireOrchestrator(event.tenantId);
    const memory = this.injectMemory(event.tenantId, creature.agentId);
    this.assertLabeled(memory);
    const resolved = this.requireThinkBind(event.tenantId, this.packs.get(event.tenantId));
    const skills = this.injectSkills(event.tenantId);
    const talking = await this.adapter.think({
      pass: "talking",
      event,
      run,
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    this.validateTalking(talking);
    this.appendWake(event, decision, run.runId);
    return {
      run,
      wokeOrchestrator: decision.wakeOrchestrator,
      wokeOps: decision.wakeOps,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  private async fieldStart(
    event: WakeEvent,
    pack: LoadedPack | undefined,
    decision: ReturnType<typeof stem>,
    until: "talking" | "card" | "done",
    holdWorker: boolean,
  ): Promise<WakeResult> {
    if (!pack) throw new AvError("NO_ACTIVE_PACK", "Habitat start requires a loaded pack");
    if (!event.goal) throw new AvError("GOAL_REQUIRED", "Habitat start requires one goal");
    const existing = this.runs.get(event.tenantId);
    if (existing && !isTerminal(existing.status) && existing.goal !== event.goal) {
      throw new AvError("ONE_GOAL", "Orchestrator SHALL dispatch one goal at a time");
    }
    const resolved = this.requireThinkBind(event.tenantId, pack);
    if (existing && existing.status === "awaiting_card" && existing.goal === event.goal) {
      // Book live + pid missing/dead (typical after process restart; leftover trailer
      // is not live): launch() recreates the process for the same workerId.
      // A live pid returns existing. Do not no-op because the directory exists.
      if (this.workers.get(event.tenantId) && !this.workers.isLive(event.tenantId)) {
        await this.ensureComputer(event.tenantId);
        const stoppedLaunch = this.ifKilled(event.tenantId);
        if (stoppedLaunch) return stoppedLaunch;
        await this.workers.launch({
          tenantId: event.tenantId,
          runId: existing.runId,
          skills: this.injectSkills(event.tenantId),
          hold: holdWorker,
        });
      }
      const stoppedFollow = this.ifKilled(event.tenantId);
      if (stoppedFollow) return stoppedFollow;
      const memory = this.injectMemory(
        event.tenantId,
        this.workers.get(event.tenantId)?.agent.agentId ?? this.orchestratorId(event.tenantId),
      );
      this.appendWake(event, decision, existing.runId, {
        followUp: true,
        ...(event.routineId ? { routineId: event.routineId } : {}),
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
    const skills = this.injectSkills(event.tenantId);
    const run =
      existing && existing.goal === event.goal
        ? existing
        : this.putRun({
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
    this.appendWake(event, decision, run.runId, {
      goal: event.goal,
      ...(event.routineId ? { routineId: event.routineId } : {}),
    });
    const memory = this.injectMemory(event.tenantId, orch.agentId);
    this.assertLabeled(memory);
    const talking = await this.adapter.think({
      pass: "talking",
      event,
      run,
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    this.validateTalking(talking);
    const stopped = this.ifKilled(event.tenantId);
    if (stopped) return stopped;
    this.putRun({
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

  private async launchOnComputer(
    tenantId: string,
    runId: string,
    skills: SkillFile[],
    hold: boolean,
  ): Promise<WorkerRecord> {
    await this.ensureComputer(tenantId);
    return this.workers.launch({ tenantId, runId, skills, hold });
  }

  private async actLaunchAndWork(
    event: WakeEvent,
    pack: LoadedPack,
    orch: AgentRecord,
    skills: SkillFile[],
    holdWorker: boolean,
    until: "talking" | "card" | "done",
  ): Promise<WakeResult> {
    const stoppedAtStart = this.ifKilled(event.tenantId);
    if (stoppedAtStart) return stoppedAtStart;
    const run = this.requireRun(event.tenantId);
    const resolved = this.requireThinkBind(event.tenantId, pack);
    const followUp = Boolean(run.workerId && this.workers.getById(event.tenantId, run.workerId));
    const worker =
      followUp && this.workers.isLive(event.tenantId)
        ? this.workers.get(event.tenantId)!
        : await this.launchOnComputer(event.tenantId, run.runId, skills, holdWorker);
    const stoppedAfterLaunch = this.ifKilled(event.tenantId);
    if (stoppedAfterLaunch) return stoppedAfterLaunch;
    if (!followUp) {
      this.opts.orchestrator.dispatch({
        orchestrator: orch,
        assignee: worker.agent,
        goal: run.goal,
      });
    }
    this.putRun({
      ...run,
      status: "working",
      workerId: worker.workerId,
      workerType: CODER_TYPE.id,
      pendingIntent: undefined,
      updatedAt: nowIso(),
    });
    const memory = this.injectMemory(event.tenantId, orch.agentId);
    this.assertLabeled(memory);
    const intent = await this.adapter.think({
      pass: "worker",
      event,
      run: this.requireRun(event.tenantId),
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    if (intent.act !== "propose_effect") {
      throw new AvError("WORKER_INTENT", "Worker pass must propose the one external effect");
    }
    const stoppedAfterThink = this.ifKilled(event.tenantId);
    if (stoppedAfterThink) return stoppedAfterThink;
    const proposed = await this.admit(pack, worker.agent, intent);
    const stoppedAfterAdmit = this.ifKilled(event.tenantId);
    if (stoppedAfterAdmit) return stoppedAfterAdmit;
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

  private async cardDecide(event: WakeEvent, pack: LoadedPack | undefined, until: "talking" | "card" | "done"): Promise<WakeResult> {
    const run = this.runs.get(event.tenantId);
    const memory = this.injectMemory(
      event.tenantId,
      this.workers.get(event.tenantId)?.agent.agentId ?? this.orchestratorId(event.tenantId),
    );
    this.appendWake(event, stem(event), run?.runId, { cardId: event.cardId, decision: event.decision });
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
      const next = this.putRun({
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
    const effect = await this.executeApprovedEffect(pack, agent, run.pendingEffect, event.cardId);
    const finished = this.finishAfterEffect(event.tenantId, { effect, cardId: event.cardId });
    if (until === "card") {
      return { ...finished, wokeOps: true };
    }
    return finished;
  }

  /**
   * Worker finished: tear the trailer down, then give the orchestrator a
   * talking pass to decide follow-up. Field does not conduct this handoff.
   * Field SHALL NOT pick who works. `done` completes the same run.
   * `follow_up` / `launch_worker` launches the next coder on that same run.
   */
  private async workerDone(event: WakeEvent, holdWorker: boolean): Promise<WakeResult> {
    this.assertFieldCannotPickAgent(event);
    const run = this.runs.get(event.tenantId);
    const decision = stem(event);
    this.appendWake(event, decision, run?.runId, { workerId: event.workerId ?? run?.workerId });
    this.expectedTeardown.add(event.tenantId);
    try {
      this.workers.teardown(event.tenantId);
    } finally {
      this.expectedTeardown.delete(event.tenantId);
    }

    if (!run || isTerminal(run.status)) {
      this.opts.orchestrator.completeGoal(event.tenantId);
      const next = run
        ? this.putRun({
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

    const open = this.putRun({
      ...run,
      status: "talking",
      pendingCardId: undefined,
      pendingEffect: undefined,
      pendingIntent: undefined,
      updatedAt: nowIso(),
    });
    const orch = this.requireOrchestrator(event.tenantId);
    const memory = this.injectMemory(event.tenantId, orch.agentId);
    this.assertLabeled(memory);
    const pack = event.pack ?? this.packs.get(event.tenantId);
    const resolved = this.requireThinkBind(event.tenantId, pack);
    const skills = this.injectSkills(event.tenantId);
    const talking = await this.adapter.think({
      pass: "talking",
      event,
      run: open,
      memory,
      skills,
      bind: resolved.bind,
      credentials: resolved.credentials,
    });
    this.validateTalking(talking);

    if (talking.act === "follow_up" || talking.act === "launch_worker") {
      if (!pack) throw new AvError("NO_ACTIVE_PACK", "Follow-up launch requires a loaded pack");
      this.putRun({
        ...open,
        pendingIntent: "launch_worker",
        updatedAt: nowIso(),
      });
      return this.actLaunchAndWork(event, pack, orch, skills, holdWorker, "card");
    }

    this.opts.orchestrator.completeGoal(event.tenantId);
    const next = this.putRun({
      ...open,
      status: "completed",
      pendingIntent: undefined,
      updatedAt: nowIso(),
    });
    return {
      run: next,
      wokeOrchestrator: true,
      wokeOps: true,
      launchedWorker: false,
      talkingDidHeavyWork: false,
      memory,
    };
  }

  /**
   * Continue / worker_done are wakes. Field SHALL NOT pick an agent,
   * worker type, or assignee. Kernel owns who works (the thin coder).
   */
  private assertFieldCannotPickAgent(event: WakeEvent): void {
    const picked =
      nonempty(event.agentId) || nonempty(event.workerType) || nonempty(event.assigneeAgentId);
    if (picked) {
      throw new AvError(
        "FIELD_CANNOT_PICK_AGENT",
        "Field SHALL NOT pick an agent; continue is a wake",
      );
    }
  }

  /**
   * Field SHALL NOT set orchestratorId or budget. Kernel owns both.
   * Fail closed — do not ignore a supplied id into the durable run.
   */
  private assertFieldCannotSetRunKernel(event: WakeEvent): void {
    if (nonempty(event.orchestratorId) || event.budget !== undefined) {
      throw new SurfaceViolationError("Field SHALL NOT set orchestratorId or budget");
    }
  }

  /**
   * Persist the run with kernel-owned fields. orchestratorId is the loaded
   * orchestrator. workers is the booked set (0 or 1). nextWake stays empty
   * until HK-024 — this is not a fire loop. budget is the kernel empty/zero.
   */
  private putRun(
    run: Omit<RunRecord, "orchestratorId" | "workers" | "nextWake" | "budget"> &
      Partial<Pick<RunRecord, "orchestratorId" | "workers" | "nextWake" | "budget">>,
  ): RunRecord {
    const booked = this.workers.get(run.tenantId);
    return this.runs.put({
      ...run,
      orchestratorId: this.requireOrchestrator(run.tenantId).agentId,
      workers: booked ? [booked.workerId] : [],
      nextWake: typeof run.nextWake === "string" ? run.nextWake : "",
      budget: KERNEL_RUN_BUDGET,
      talkingDidHeavyWork: false,
    });
  }

  private kill(event: WakeEvent): WakeResult {
    const run = this.runs.get(event.tenantId);
    this.appendWake(event, stem(event), run?.runId, { reason: event.reason ?? "kill" });
    this.expectedTeardown.add(event.tenantId);
    try {
      this.workers.teardown(event.tenantId);
    } finally {
      this.expectedTeardown.delete(event.tenantId);
    }
    this.opts.orchestrator.completeGoal(event.tenantId);
    const next = run
      ? this.putRun({
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

  private async finishAfterEffect(
    tenantId: string,
    proposed: { effect?: EffectResult; cardId?: string },
  ): Promise<WakeResult> {
    const done = await this.wake({ kind: "worker_done", tenantId });
    return {
      ...done,
      effect: proposed.effect,
      cardId: proposed.cardId,
    };
  }

  /**
   * Explicit re-ask. An authorized grant for that class must be used.
   * Re-ask without a reason (no grant, grant revoked, class mismatch,
   * human_decision) fails closed as HABITAT_REASK — not a silent second card.
   */
  askForClass(input: {
    tenantId: string;
    actionClass: string;
    proposedClass?: string;
    ceiling?: ActionCeiling;
  }): HabitatAskReason {
    return assertHabitatMayAsk(
      habitatAskReason({
        grants: this.opts.grants,
        tenantId: input.tenantId,
        actionClass: input.actionClass,
        proposedClass: input.proposedClass,
        ceiling: input.ceiling,
      }),
    );
  }

  private async admit(
    pack: LoadedPack,
    agent: AgentRecord,
    intent: CognitiveIntent,
  ): Promise<{ effect?: EffectResult; cardId?: string }> {
    const run = this.requireRun(pack.tenantId);
    const actionClass = intent.actionClass ?? "communicate";
    const verb = pack.binding.actionClassVerbs.find((v) => v.id === actionClass);
    const askReason = habitatAskReason({
      grants: this.opts.grants,
      tenantId: pack.tenantId,
      actionClass,
      ceiling: verb?.ceiling,
      channel: intent.channel ?? "unspecified",
      purpose: intent.purpose ?? "unspecified",
      subject: intent.subject ?? "unspecified",
    });
    try {
      const effect = await this.executeApprovedEffect(pack, agent, {
        actionClass,
        channel: intent.channel ?? "unspecified",
        purpose: intent.purpose ?? "unspecified",
        subject: intent.subject ?? "unspecified",
        agentId: agent.agentId,
        ...connectorSendFields(intent),
      });
      this.putRun({
        ...run,
        status: "working",
        updatedAt: nowIso(),
      });
      return { effect };
    } catch (err) {
      if (err instanceof AuthorizationRequiredError) {
        assertHabitatMayAsk(askReason);
        this.putRun({
          ...run,
          status: "awaiting_card",
          pendingCardId: err.cardId,
          pendingEffect: {
            actionClass,
            channel: intent.channel ?? "unspecified",
            purpose: intent.purpose ?? "unspecified",
            subject: intent.subject ?? "unspecified",
            agentId: agent.agentId,
            ...connectorSendFields(intent),
          },
          updatedAt: nowIso(),
        });
        return { cardId: err.cardId };
      }
      throw err;
    }
  }

  /**
   * Admission then a live connector send (email/SMS) or handle, or typed fail-closed.
   * Writing executed without a world send is autonomy theater.
   */
  private async executeApprovedEffect(
    pack: LoadedPack,
    agent: AgentRecord,
    pending: {
      actionClass: string;
      channel: string;
      purpose: string;
      subject: string;
      agentId: string;
      to?: string;
      body?: string;
      from?: string;
    },
    approvedCardId?: string,
  ): Promise<EffectResult> {
    const send = connectorSendFields(pending);
    const admitted = this.opts.effects.execute({
      pack,
      agent,
      actionClass: pending.actionClass,
      channel: pending.channel,
      purpose: pending.purpose,
      subject: pending.subject,
      surface: "field",
      approvedCardId,
      recordExecution: false,
    });
    if (admitted.executed) return admitted;
    await invokeConnectorWorld({
      computerBaseDir: this.opts.computerBaseDir,
      tenantId: pack.tenantId,
      pack,
      actionClass: pending.actionClass,
      channel: pending.channel,
      purpose: pending.purpose,
      subject: pending.subject,
      ...send,
    });
    return this.opts.effects.commitExternal(admitted.actionId, {
      pack,
      agent,
      actionClass: pending.actionClass,
      channel: pending.channel,
      purpose: pending.purpose,
      subject: pending.subject,
      surface: "field",
      approvedCardId,
    }, admitted.policyDecision);
  }

  /**
   * Architect bind is required for DeepAgentsAdapter think (HK-055).
   * Pack defaultModelId is not live. Missing bind is ADAPTER_UNBOUND.
   * Bind outside a declared allow-list is ADAPTER_NOT_ALLOWED.
   * Product think also requires Architect-written provider credentials
   * (ADAPTER_CREDENTIALS_MISSING). An explicit CI thinkFn double does not.
   * Dry-stem (explicit eval / test fixture) does not require a bind.
   */
  private requireThinkBind(
    tenantId: string,
    pack: LoadedPack | undefined,
  ): { bind?: AdapterBind; credentials?: AdapterCredentials } {
    if (!this.adapter.requiresBind) return {};
    const record = readTenantAdapterBind(this.opts.computerBaseDir, tenantId);
    if (!record) {
      throw new AvError(
        "ADAPTER_UNBOUND",
        "Architect must bind a model before think; no silent default",
      );
    }
    const allow = pack?.binding.adapter?.allowList;
    if (allow && !allow.includes(record.modelId)) {
      throw new AvError(
        "ADAPTER_NOT_ALLOWED",
        `Bound model ${record.modelId} is not on the pack allow-list`,
      );
    }
    const bind: AdapterBind = { modelId: record.modelId };
    if (record.vendorBaseUrl) bind.vendorBaseUrl = record.vendorBaseUrl;
    if (!this.adapter.requiresCredentials) {
      return { bind };
    }
    const creds = readTenantAdapterCredentials(this.opts.computerBaseDir, tenantId);
    if (!creds) {
      throw new AvError(
        "ADAPTER_CREDENTIALS_MISSING",
        "Architect must write provider credentials before think; no CI mapper default",
      );
    }
    return { bind, credentials: { apiKey: creds.apiKey } };
  }

  private validateTalking(intent: CognitiveIntent): void {
    if (intent.pass !== "talking") {
      throw new AvError("TALKING_PASS", "Talking pass must stay a talking pass");
    }
    if (intent.act === "propose_effect") {
      throw new AvError("TALKING_PASS", "Talking pass must not do heavy work");
    }
  }

  /**
   * Self-improve door (HK-071). Writes a skill draft or strategy note onto
   * tenant disk as a proposal. Not a live skill. Not policy. Not promotion.
   * Think cannot write a live skill. Habitat cannot promote itself.
   */
  writeProposal(input: {
    tenantId: string;
    name: string;
    kind: ProposalKind;
    description: string;
    body: string;
  }): ProposalFile {
    if (!this.opts.computerBaseDir) {
      throw new AvError("PROPOSAL_STORE_MISSING", "Proposal store is missing; refusing to invent a proposal");
    }
    return writeProposalFile(this.opts.computerBaseDir, input.tenantId, {
      name: input.name,
      kind: input.kind,
      description: input.description,
      body: input.body,
    });
  }

  /**
   * Habitat cannot promote a proposal into a live skill (DEC-013 / DEC-023).
   * Promotion is Architect + eval only. Surprise graduation is a product failure.
   */
  promoteProposal(_input?: { tenantId: string; name: string }): never {
    throw new AvError(
      "HABITAT_CANNOT_PROMOTE",
      "Habitat cannot promote itself; promotion is Architect + eval only",
    );
  }

  /**
   * Load Architect-written skill files for think. Empty store is no skills.
   * Missing or corrupt files fail closed. Does not invent stubs from pack labels.
   * Does not load proposals — a proposal is not a skill.
   */
  private injectSkills(tenantId: string): SkillFile[] {
    return loadSkillFiles(this.opts.computerBaseDir, tenantId);
  }

  /**
   * Load durable disk memory for think. Empty store is empty labeled memory.
   * Missing disk or corrupt files fail closed. An unlabeled stub is a diary.
   */
  private injectMemory(tenantId: string, agentId: string): LabeledMemory {
    const memory = this.memory.labeled(tenantId, agentId);
    this.assertLabeled(memory);
    return memory;
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

function nonempty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function defaultUntil(kind: WakeEvent["kind"]): "talking" | "card" | "done" {
  if (kind === "field_start" || kind === "routine") return "card";
  if (kind === "architect_message" || kind === "worker_failed") return "done";
  return "done";
}
