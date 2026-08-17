import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentRecord } from "../agents/types.js";
import type { ComputerHost } from "../computer/host.js";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import { copySkillsToTrailer } from "./skills.js";
import {
  CODER_TYPE,
  isAdmittedWorkerType,
  kernelTrailerExpiresAt,
  type SkillFile,
  type WorkerRecord,
  type WorkerTypeId,
} from "./types.js";

/** Busybox/ash on the tenant computer. Alpine has no Node. */
function coderExecSource(hold?: boolean): string {
  return `#!/bin/sh
printf 'coder-executor\\n' > executor-output.txt
${hold ? "while true; do sleep 2147483647; done\n" : ""}`;
}

/**
 * Thin worker book. coder is executor + branch on the tenant computer.
 * Other v1 types are admitted bookings without a second computer primitive.
 * Trailer isolation is torn down on worker_done / kill / kernel TTL.
 * The role-agent Xvfb session is a different lifetime — teardown does not stop it.
 * The coder process runs inside the tenant machine (computer.execInMachine / spawnHeld).
 * Not in the kernel process. Not a host Node child of the kernel.
 */
export interface TenantWorkerStore {
  workers: WorkerRecord[];
}

/**
 * Thin worker book. One booked worker per tenant, persisted beside runs.json.
 * Control state, not a business fact. Hydrate from disk; do not invent a worker id.
 * Liveness is pid, not the trailer directory. A leftover trailer is not a live worker.
 * coder launches on the tenant computer. Other admitted types book without a runtime.
 */
export class WorkerBook {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly hydrated = new Set<string>();
  private readonly corrupt = new Map<string, AvError>();
  /** Pids this book spawnHeld in this instance. Hydrated leftover pids are not held here. */
  private readonly heldHere = new Set<number>();

  constructor(
    private readonly computerBaseDir?: string,
    private computer?: ComputerHost,
  ) {}

  attachComputer(computer: ComputerHost): void {
    this.computer = computer;
  }

  get(tenantId: string): WorkerRecord | undefined {
    this.ensure(tenantId);
    return this.workers.get(tenantId);
  }

  getById(tenantId: string, workerId: string): WorkerRecord | undefined {
    const worker = this.get(tenantId);
    return worker?.workerId === workerId ? worker : undefined;
  }

  /** True only when the booked pid is still running. Directory presence is not liveness. */
  isLive(tenantId: string): boolean {
    return isPidAlive(this.get(tenantId)?.pid);
  }

  /**
   * True when this book instance spawnHeld the booked pid.
   * A leftover pid after restart (hydrated from workers.json) is not held here.
   */
  isHeldHere(tenantId: string): boolean {
    const pid = this.get(tenantId)?.pid;
    return typeof pid === "number" && this.heldHere.has(pid);
  }

  /**
   * Admit and book a v1 worker type. coder keeps today's trailer launch.
   * executor / retriever / browser persist as typed workers without a computer spawn.
   */
  async book(input: {
    tenantId: string;
    runId: string;
    type: WorkerTypeId;
    skills?: SkillFile[];
    hold?: boolean;
  }): Promise<WorkerRecord> {
    if (input.type === CODER_TYPE.id) {
      return this.launch({
        tenantId: input.tenantId,
        runId: input.runId,
        skills: input.skills,
        hold: input.hold,
      });
    }
    return this.bookTyped(input);
  }

  async launch(input: {
    tenantId: string;
    runId: string;
    skills?: SkillFile[];
    hold?: boolean;
  }): Promise<WorkerRecord> {
    if (!this.computerBaseDir) {
      throw new AvError("WORKER_COMPUTER_REQUIRED", "Workers run on the tenant computer");
    }
    const existing = this.get(input.tenantId);
    if (existing) {
      if (existing.type !== CODER_TYPE.id) {
        this.teardown(input.tenantId);
      } else if (isPidAlive(existing.pid)) {
        return existing;
      } else {
        return this.spawnTrailer(
          { ...existing, expiresAt: kernelTrailerExpiresAt(nowIso()) },
          input.skills,
          input.hold,
        );
      }
    }
    const workerId = newId("worker");
    const paths = computerRoot(this.computerBaseDir, input.tenantId);
    const createdAt = nowIso();
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
        createdAt,
        expiresAt: kernelTrailerExpiresAt(createdAt),
      },
      input.skills,
      input.hold,
    );
  }

  trailerExists(tenantId: string): boolean {
    const worker = this.get(tenantId);
    return Boolean(worker?.trailerPath && existsSync(worker.trailerPath));
  }

  executorOutput(tenantId: string): string | undefined {
    const worker = this.get(tenantId);
    if (!worker?.trailerPath) return undefined;
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
      this.heldHere.delete(worker.pid);
      forgetHeldCoder(worker.pid);
      terminatePid(worker.pid);
    }
    if (worker.trailerPath) removeTrailer(worker.trailerPath);
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

  /** Book an admitted non-coder type. No trailer. No computer spawn. No invented runtime. */
  private bookTyped(input: { tenantId: string; runId: string; type: WorkerTypeId }): WorkerRecord {
    const existing = this.get(input.tenantId);
    if (existing?.type === input.type) return existing;
    if (existing) this.teardown(input.tenantId);
    const workerId = newId("worker");
    const record: WorkerRecord = {
      workerId,
      tenantId: input.tenantId,
      runId: input.runId,
      type: input.type,
      agent: typedAgent(input.tenantId, workerId, input.type),
      createdAt: nowIso(),
    };
    this.workers.set(input.tenantId, record);
    this.persist(input.tenantId);
    return record;
  }

  /** Recreate the trailer/process for this workerId. Does not mint a different id. */
  private async spawnTrailer(record: WorkerRecord, skills?: SkillFile[], hold?: boolean): Promise<WorkerRecord> {
    if (!this.computer) {
      throw new AvError("WORKER_COMPUTER_REQUIRED", "Workers run on the tenant computer");
    }
    if (record.type !== CODER_TYPE.id || !record.trailerPath || !record.branch) {
      throw new AvError("WORKER_COMPUTER_REQUIRED", "Only coder launches on the tenant computer");
    }
    mkdirSync(record.trailerPath, { recursive: true });
    this.initBranch(record.trailerPath, record.branch);
    if (skills?.length) copySkillsToTrailer(skills, record.trailerPath);
    const execFile = path.join(record.trailerPath, "coder-exec.sh");
    writeFileSync(execFile, coderExecSource(hold), "utf8");
    const guestCwd = `/home/trailers/${record.workerId}`;
    const argv = ["/bin/sh", `${guestCwd}/coder-exec.sh`];
    // Product field start holds via spawnHeld inside the tenant machine.
    // Fixture/eval may omit hold and execInMachine so the executor writes and exits.
    // Not a host Node child of the kernel. Reap on kill / worker_done, not on start.
    let pid: number | undefined;
    if (hold) {
      const held = await this.computer.spawnHeld({
        tenantId: record.tenantId,
        agentId: record.agent.agentId,
        argv,
        cwd: guestCwd,
      });
      rememberHeldPid(held.pid);
      this.heldHere.add(held.pid);
      pid = held.pid;
    } else {
      const result = await this.computer.execInMachine({
        tenantId: record.tenantId,
        agentId: record.agent.agentId,
        argv,
        cwd: guestCwd,
      });
      pid = result.pid;
    }
    const next: WorkerRecord = { ...record, pid };
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
    try {
      execFileSync("git", ["init"], { cwd: trailerPath, stdio: "ignore" });
    } catch {
      // Leftover trailer may already be a repo. Keep the directory.
    }
    writeFileSync(path.join(trailerPath, ".branch"), `${branch}\n`, "utf8");
    try {
      execFileSync("git", ["checkout", "-B", branch], { cwd: trailerPath, stdio: "ignore" });
    } catch {
      try {
        execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], {
          cwd: trailerPath,
          stdio: "ignore",
        });
      } catch {
        // Branch file is enough; do not throw away the trailer.
      }
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

function typedAgent(tenantId: string, workerId: string, type: WorkerTypeId): AgentRecord {
  return {
    agentId: workerId,
    tenantId,
    name: type,
    persona: `Booked ${type} worker. Not a computer trailer.`,
    skills: [],
    specialties: [type],
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
    !isAdmittedWorkerType(raw.type) ||
    typeof raw.createdAt !== "string" ||
    !raw.createdAt
  ) {
    throw new AvError("WORKER_STORE_CORRUPT", "Worker store is corrupt; refusing to invent a worker");
  }
  if (raw.type === CODER_TYPE.id) {
    if (
      raw.isolation !== "trailer" ||
      typeof raw.trailerPath !== "string" ||
      !raw.trailerPath ||
      typeof raw.branch !== "string" ||
      !raw.branch
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
      expiresAt: parseCoderExpiresAt(raw.expiresAt, raw.createdAt),
    };
    if (typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0) {
      record.pid = raw.pid;
    }
    return record;
  }
  if (
    raw.isolation !== undefined ||
    raw.trailerPath !== undefined ||
    raw.branch !== undefined ||
    raw.pid !== undefined ||
    raw.expiresAt !== undefined
  ) {
    throw new AvError("WORKER_STORE_CORRUPT", "Worker store is corrupt; refusing to invent a worker");
  }
  return {
    workerId: raw.workerId,
    tenantId: raw.tenantId,
    runId: raw.runId,
    type: raw.type,
    agent: parseAgent(raw.agent, raw.tenantId),
    createdAt: raw.createdAt,
  };
}

/** Coder expiry is kernel-owned. Absent on disk derives from createdAt + TTL so leftovers still lease. */
function parseCoderExpiresAt(raw: unknown, createdAt: string): string {
  if (raw === undefined) return kernelTrailerExpiresAt(createdAt);
  if (typeof raw !== "string" || !raw || !Number.isFinite(Date.parse(raw))) {
    throw new AvError("WORKER_STORE_CORRUPT", "Worker store is corrupt; refusing to invent a worker");
  }
  return raw;
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

const heldPids = new Set<number>();

function rememberHeldPid(pid: number): void {
  heldPids.add(pid);
}

function forgetHeldCoder(pid: number): void {
  heldPids.delete(pid);
}

/** Signal the host-visible handle (unshare / docker exec). Do not kill the process group. */
function terminatePid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && isPidAlive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    const hard = Date.now() + 1000;
    while (Date.now() < hard && isPidAlive(pid)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function removeTrailer(trailerPath: string): void {
  const deadline = Date.now() + 2000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      rmSync(trailerPath, { recursive: true, force: true });
      if (!existsSync(trailerPath)) return;
    } catch (err) {
      last = err;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  try {
    rmSync(trailerPath, { recursive: true, force: true });
  } catch (err) {
    throw last ?? err;
  }
}

/** SIGTERM leftover held coder children. Tests use this so HTTP-start hold does not leak. */
export function reapHeldCoders(): void {
  for (const pid of [...heldPids]) {
    terminatePid(pid);
  }
  heldPids.clear();
}

/** Live only if the pid is running and not a zombie. Directory presence is irrelevant. */
export function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const proc = `/proc/${pid}`;
  if (!existsSync(proc)) return false;
  try {
    const status = readFileSync(path.join(proc, "status"), "utf8");
    const stateLine = status.split("\n").find((line) => line.startsWith("State:"));
    if (stateLine && stateLine.slice("State:".length).trim().charAt(0) === "Z") return false;
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(path.join(proc, "stat"), "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).charAt(0);
    if (state === "Z") return false;
  } catch {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
