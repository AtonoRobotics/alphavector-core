import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentRecord } from "../agents/types.js";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
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
export class WorkerBook {
  private readonly workers = new Map<string, WorkerRecord>();

  constructor(private readonly computerBaseDir?: string) {}

  get(tenantId: string): WorkerRecord | undefined {
    return this.workers.get(tenantId);
  }

  getById(tenantId: string, workerId: string): WorkerRecord | undefined {
    const worker = this.workers.get(tenantId);
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
    const existing = this.workers.get(input.tenantId);
    if (existing) {
      return existing;
    }
    const workerId = newId("worker");
    const paths = computerRoot(this.computerBaseDir, input.tenantId);
    const trailerPath = path.join(paths.trailersDir, workerId);
    mkdirSync(trailerPath, { recursive: true });
    const branch = `coder/${workerId}`;
    this.initBranch(trailerPath, branch);
    if (input.skills?.length) copySkillsToTrailer(input.skills, trailerPath);
    const execFile = path.join(trailerPath, "coder-exec.mjs");
    writeFileSync(execFile, CODER_EXEC_SOURCE, "utf8");
    const child = spawn(process.execPath, [execFile], {
      cwd: trailerPath,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AV_CODER_HOLD: input.hold ? "1" : "0",
      },
    });
    child.unref();
    const agent = coderAgent(input.tenantId, workerId);
    const record: WorkerRecord = {
      workerId,
      tenantId: input.tenantId,
      runId: input.runId,
      type: CODER_TYPE.id,
      isolation: "trailer",
      trailerPath,
      branch,
      pid: child.pid,
      agent,
      createdAt: nowIso(),
    };
    this.workers.set(input.tenantId, record);
    return record;
  }

  trailerExists(tenantId: string): boolean {
    const worker = this.workers.get(tenantId);
    return Boolean(worker && existsSync(worker.trailerPath));
  }

  executorOutput(tenantId: string): string | undefined {
    const worker = this.workers.get(tenantId);
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
    const worker = this.workers.get(tenantId);
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
