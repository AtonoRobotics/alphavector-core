import { ComputerError } from "../errors.js";
import { newId } from "../ids.js";
import type { ComputerHost } from "./host.js";

export interface ComputerUseTask {
  tenantId: string;
  agentId: string;
  goal: string;
}

export interface ComputerUseHandle {
  id: string;
  status: "queued" | "running" | "paused_for_architect" | "completed" | "failed";
  note: string;
}

/**
 * Desktop and browser interaction is delegated here.
 * Agents get shell, structured file read, and a screenshot of their desktop.
 * They do not drive X11 or type passwords.
 */
export class ComputerUseWorker {
  private readonly jobs = new Map<string, ComputerUseHandle>();

  constructor(private readonly host: ComputerHost) {}

  async enqueue(task: ComputerUseTask): Promise<ComputerUseHandle> {
    const desktop = await this.host.ensureDesktop(task.tenantId, task.agentId);
    const handle: ComputerUseHandle = {
      id: newId("cu"),
      status: "running",
      note: `Worker attached to display :${desktop.display}. Agent cannot drive the desktop. Goal: ${task.goal}`,
    };
    this.jobs.set(handle.id, handle);
    return handle;
  }

  async pauseForArchitect(jobId: string): Promise<ComputerUseHandle> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new ComputerError("WORKER_JOB_MISSING", "Computer-use job not found");
    }
    job.status = "paused_for_architect";
    job.note = "Architect takeover. Login, 2FA, captcha, and payment stay with the architect.";
    return job;
  }

  get(jobId: string): ComputerUseHandle | undefined {
    return this.jobs.get(jobId);
  }
}
