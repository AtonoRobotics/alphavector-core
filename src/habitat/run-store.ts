import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import { isAdmittedWorkerType, KERNEL_RUN_BUDGET, type RunRecord } from "./types.js";

const STATUSES = new Set([
  "open",
  "talking",
  "working",
  "awaiting_card",
  "completed",
  "denied",
  "killed",
]);

export interface TenantRunStore {
  runs: RunRecord[];
}

export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly hydrated = new Set<string>();
  private readonly corrupt = new Map<string, AvError>();

  constructor(private readonly computerBaseDir?: string) {}

  get(tenantId: string): RunRecord | undefined {
    this.ensure(tenantId);
    return this.runs.get(tenantId);
  }

  put(run: RunRecord): RunRecord {
    this.ensure(run.tenantId);
    this.runs.set(run.tenantId, run);
    this.persist(run.tenantId);
    return run;
  }

  private ensure(tenantId: string): void {
    const failed = this.corrupt.get(tenantId);
    if (failed) throw failed;
    if (!this.computerBaseDir || this.hydrated.has(tenantId)) return;
    this.hydrated.add(tenantId);
    try {
      const store = loadRunStore(this.fileFor(tenantId));
      const current = store.runs.find((run) => run.tenantId === tenantId);
      if (current) this.runs.set(tenantId, current);
    } catch (err) {
      const closed =
        err instanceof AvError
          ? err
          : new AvError("RUN_STORE_CORRUPT", "Run store is corrupt; refusing to invent a run");
      this.corrupt.set(tenantId, closed);
      throw closed;
    }
  }

  private persist(tenantId: string): void {
    if (!this.computerBaseDir) return;
    const run = this.runs.get(tenantId);
    saveRunStore(this.fileFor(tenantId), { runs: run ? [run] : [] });
  }

  private fileFor(tenantId: string): string {
    return computerRoot(this.computerBaseDir!, tenantId).runsFile;
  }
}

export function loadRunStore(file: string): TenantRunStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("RUN_STORE_CORRUPT", "Run store is corrupt; refusing to invent a run");
  }
  if (raw === undefined) return { runs: [] };
  return parseStore(raw);
}

export function saveRunStore(file: string, store: TenantRunStore): void {
  writeJsonAtomic(file, store);
}

function parseStore(raw: unknown): TenantRunStore {
  if (!isRecord(raw) || !Array.isArray(raw.runs)) {
    throw new AvError("RUN_STORE_CORRUPT", "Run store is corrupt; refusing to invent a run");
  }
  return { runs: raw.runs.map(parseRun) };
}

function parseRun(raw: unknown): RunRecord {
  if (
    !isRecord(raw) ||
    typeof raw.runId !== "string" ||
    !raw.runId ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.goal !== "string" ||
    typeof raw.status !== "string" ||
    !STATUSES.has(raw.status) ||
    typeof raw.orchestratorId !== "string" ||
    !raw.orchestratorId ||
    !isWorkerIdSet(raw.workers) ||
    (raw.nextWake !== undefined && !isPersistedNextWake(raw.nextWake)) ||
    !isKernelBudget(raw.budget) ||
    raw.talkingDidHeavyWork !== false ||
    typeof raw.createdAt !== "string" ||
    typeof raw.updatedAt !== "string"
  ) {
    throw new AvError("RUN_STORE_CORRUPT", "Run store is corrupt; refusing to invent a run");
  }
  const run: RunRecord = {
    runId: raw.runId,
    tenantId: raw.tenantId,
    goal: raw.goal,
    status: raw.status as RunRecord["status"],
    orchestratorId: raw.orchestratorId,
    workers: [...raw.workers],
    nextWake: typeof raw.nextWake === "string" ? raw.nextWake : "",
    budget: raw.budget,
    talkingDidHeavyWork: false,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (typeof raw.workerId === "string") run.workerId = raw.workerId;
  if (raw.workerType !== undefined) {
    if (!isAdmittedWorkerType(raw.workerType)) {
      throw new AvError("RUN_STORE_CORRUPT", "Run store is corrupt; refusing to invent a run");
    }
    run.workerType = raw.workerType;
  }
  if (typeof raw.pendingCardId === "string") run.pendingCardId = raw.pendingCardId;
  if (typeof raw.journeyId === "string") run.journeyId = raw.journeyId;
  if (typeof raw.recordId === "string") run.recordId = raw.recordId;
  if (raw.pendingIntent === "launch_worker") run.pendingIntent = "launch_worker";
  if (raw.talkingReject !== undefined) {
    if (
      !isRecord(raw.talkingReject) ||
      typeof raw.talkingReject.code !== "string" ||
      !raw.talkingReject.code ||
      raw.talkingReject.closed !== true
    ) {
      throw new AvError("RUN_STORE_CORRUPT", "Run store is corrupt; refusing to invent a run");
    }
    run.talkingReject = { code: raw.talkingReject.code, closed: true };
  }
  if (isRecord(raw.pendingEffect)) {
    const effect = raw.pendingEffect;
    if (
      typeof effect.actionClass === "string" &&
      typeof effect.channel === "string" &&
      typeof effect.purpose === "string" &&
      typeof effect.subject === "string" &&
      typeof effect.agentId === "string"
    ) {
      run.pendingEffect = {
        actionClass: effect.actionClass,
        channel: effect.channel,
        purpose: effect.purpose,
        subject: effect.subject,
        agentId: effect.agentId,
        ...(typeof effect.to === "string" && effect.to.trim() ? { to: effect.to.trim() } : {}),
        ...(typeof effect.body === "string" && effect.body.trim() ? { body: effect.body.trim() } : {}),
        ...(typeof effect.from === "string" && effect.from.trim() ? { from: effect.from.trim() } : {}),
      };
    }
  }
  return run;
}

function isWorkerIdSet(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

function isKernelBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value === KERNEL_RUN_BUDGET;
}

/** Empty or a parseable ISO time. Garbage on disk is fail-closed. */
function isPersistedNextWake(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
