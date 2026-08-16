import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentRecord } from "../agents/types.js";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import { copySkillsToTrailer } from "./skills.js";
import { CODER_TYPE, type SkillFile, type WorkerRecord } from "./types.js";

const CODER_EXEC_SOURCE = `import { writeFileSync } from "node:fs";
import path from "node:path";
writeFileSync(path.join(process.cwd(), "executor-output.txt"), "coder-executor\\n", "utf8");
if (process.env.AV_CODER_HOLD === "1") {
  setInterval(() => {}, 1 << 30);
}
`;

/**
 * Thin coder worker: executor + branch on the tenant computer.
 * Habitat owns the coder type. Trailer isolation is torn down on worker_done / kill.
 */
export interface TenantWorkerStore {
  workers: WorkerRecord[];
}

/**
 * Thin coder book. One live worker per tenant, persisted beside runs.json.
 * Control state, not a business fact. Hydrate from disk; do not invent a worker id.
 */
export class WorkerBook {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly hydrated = new Set<string>();
  private readonly corrupt = new Map<string, AvError>();

  constructor(private readonly computerBaseDir?: string) {}

  get(tenantId: string): WorkerRecord | undefined {
    this.ensure(tenantId);
    return this.workers.get(tenantId);
  }

  getById(tenantId: string, workerId: string): WorkerRecord | undefined {
    const worker = this.get(tenantId);
    return worker?.workerId === workerId ? worker : undefined;
  }

  launch(input: {
    tenantId: string;
    runId: string;
    skills?: SkillFile[];
    hold?: boolean;
  }): WorkerRecord {
    if (!this.computerBaseDir) {
      throw new AvError("WORKER_COMPUTER_REQUIRED", "Workers run on the tenant computer");
    }
    const existing = this.get(input.tenantId);
    if (existing) {
      if (existsSync(existing.trailerPath)) return existing;
      return this.spawnTrailer(existing, input.skills, input.hold);
    }
    const workerId = newId("worker");
    const paths = computerRoot(this.computerBaseDir, input.tenantId);
    return this.spawnTrailer(
      {
        workerId,
        tenantId: input.tenantId,
        runId: input.runId,
        type: CODER_TYPE.id,
        isolation: "trailer",
        trailerPath: path.join(paths.trailersDir, workerId),
        branch: `coder/${workerId}`,
        agent: coderAgent(input.tenantId, workerId),
        createdAt: nowIso(),
      },
      input.skills,
      input.hold,
    );
  }

  trailerExists(tenantId: string): boolean {
    const worker = this.get(tenantId);
    return Boolean(worker && existsSync(worker.trailerPath));
  }

  executorOutput(tenantId: string): string | undefined {
    const worker = this.get(tenantId);
    if (!worker) return undefined;
    const file = path.join(worker.trailerPath, "executor-output.txt");
    if (!existsSync(file)) return undefined;
    return file;
  }

  waitForExecutor(tenantId: string, ms = 2000): boolean {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.executorOutput(tenantId)) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return Boolean(this.executorOutput(tenantId));
  }

  teardown(tenantId: string): void {
    const worker = this.get(tenantId);
    if (!worker) return;
    if (worker.pid) {
      try {
        process.kill(-worker.pid, "SIGTERM");
      } catch {
        try {
          process.kill(worker.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    rmSync(worker.trailerPath, { recursive: true, force: true });
    this.workers.delete(tenantId);
    this.persist(tenantId);
  }

  private ensure(tenantId: string): void {
    const failed = this.corrupt.get(tenantId);
    if (failed) throw failed;
    if (!this.computerBaseDir || this.hydrated.has(tenantId)) return;
    this.hydrated.add(tenantId);
    try {
      const store = loadWorkerStore(this.fileFor(tenantId));
      const current = store.workers.find((worker) => worker.tenantId === tenantId);
      if (current) this.workers.set(tenantId, current);
    } catch (err) {
      const closed =
        err instanceof AvError
          ? err
          : new AvError("WORKER_STORE_CORRUPT", "Worker store is corrupt; refusing to invent a worker");
      this.corrupt.set(tenantId, closed);
      throw closed;
    }
  }

  /** Recreate the trailer/process for this workerId. Does not mint a different id. */
  private spawnTrailer(record: WorkerRecord, skills?: SkillFile[], hold?: boolean): WorkerRecord {
    mkdirSync(record.trailerPath, { recursive: true });
    this.initBranch(record.trailerPath, record.branch);
    if (skills?.length) copySkillsToTrailer(skills, record.trailerPath);
    const execFile = path.join(record.trailerPath, "coder-exec.mjs");
    writeFileSync(execFile, CODER_EXEC_SOURCE, "utf8");
    const child = spawn(process.execPath, [execFile], {
      cwd: record.trailerPath,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AV_CODER_HOLD: hold ? "1" : "0",
      },
    });
    child.unref();
    const next: WorkerRecord = { ...record, pid: child.pid };
    this.workers.set(record.tenantId, next);
    this.persist(record.tenantId);
    return next;
  }

  private persist(tenantId: string): void {
    if (!this.computerBaseDir) return;
    const worker = this.workers.get(tenantId);
    saveWorkerStore(this.fileFor(tenantId), { workers: worker ? [worker] : [] });
  }

  private fileFor(tenantId: string): string {
    return computerRoot(this.computerBaseDir!, tenantId).workersFile;
  }

  private initBranch(trailerPath: string, branch: string): void {
    execFileSync("git", ["init"], { cwd: trailerPath, stdio: "ignore" });
    writeFileSync(path.join(trailerPath, ".branch"), `${branch}\n`, "utf8");
    try {
      execFileSync("git", ["checkout", "-B", branch], { cwd: trailerPath, stdio: "ignore" });
    } catch {
      execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], {
        cwd: trailerPath,
        stdio: "ignore",
      });
    }
  }
}

function coderAgent(tenantId: string, workerId: string): AgentRecord {
  return {
    agentId: workerId,
    tenantId,
    name: "coder",
    persona: "Thin coder: executor and branch on the tenant computer.",
    skills: ["executor", "branch"],
    specialties: ["coder"],
    isOrchestrator: false,
    createdAt: nowIso(),
  };
}

export function loadWorkerStore(file: string): TenantWorkerStore {
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(file);
  } catch {
    throw new AvError("WORKER_STORE_CORRUPT", "Worker store is corrupt; refusing to invent a worker");
  }
  if (raw === undefined) return { workers: [] };
  return parseStore(raw);
}

export function saveWorkerStore(file: string, store: TenantWorkerStore): void {
  writeJsonAtomic(file, store);
}

function parseStore(raw: unknown): TenantWorkerStore {
  if (!isRecord(raw) || !Array.isArray(raw.workers)) {
    throw new AvError("WORKER_STORE_CORRUPT", "Worker store is corrupt; refusing to invent a worker");
  }
  return { workers: raw.workers.map(parseWorker) };
}

function parseWorker(raw: unknown): WorkerRecord {
  if (
    !isRecord(raw) ||
    typeof raw.workerId !== "string" ||
    !raw.workerId ||
    typeof raw.tenantId !== "string" ||
    !raw.tenantId ||
    typeof raw.runId !== "string" ||
    !raw.runId ||
    raw.type !== CODER_TYPE.id ||
    raw.isolation !== "trailer" ||
    typeof raw.trailerPath !== "string" ||
    !raw.trailerPath ||
    typeof raw.branch !== "string" ||
    !raw.branch ||
    typeof raw.createdAt !== "string" ||
    !raw.createdAt
  ) {
    throw new AvError("WORKER_STORE_CORRUPT", "Worker store is corrupt; refusing to invent a worker");
  }
  const record: WorkerRecord = {
    workerId: raw.workerId,
    tenantId: raw.tenantId,
    runId: raw.runId,
    type: CODER_TYPE.id,
    isolation: "trailer",
    trailerPath: raw.trailerPath,
    branch: raw.branch,
    agent: parseAgent(raw.agent, raw.tenantId),
    createdAt: raw.createdAt,
  };
  if (typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0) {
    record.pid = raw.pid;
  }
  return record;
}

function parseAgent(raw: unknown, tenantId: string): AgentRecord {
  if (
    !isRecord(raw) ||
    typeof raw.agentId !== "string" ||
    !raw.agentId ||
    raw.tenantId !== tenantId ||
    typeof raw.name !== "string" ||
    typeof raw.persona !== "string" ||
    !Array.isArray(raw.skills) ||
    !raw.skills.every((s) => typeof s === "string") ||
    !Array.isArray(raw.specialties) ||
    !raw.specialties.every((s) => typeof s === "string") ||
    typeof raw.isOrchestrator !== "boolean" ||
    typeof raw.createdAt !== "string"
  ) {
    throw new AvError("WORKER_STORE_CORRUPT", "Worker store is corrupt; refusing to invent a worker");
  }
  return {
    agentId: raw.agentId,
    tenantId,
    name: raw.name,
    persona: raw.persona,
    skills: raw.skills,
    specialties: raw.specialties,
    isOrchestrator: raw.isOrchestrator,
    createdAt: raw.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
