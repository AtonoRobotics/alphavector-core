import { FailClosedError } from "../errors.js";
import { newId } from "../ids.js";
import type { ComputerHost } from "./host.js";
import type { ComputerUseHandle, ComputerUseTask } from "./types.js";

/**
 * Desktop and browser interaction is delegated to this worker.
 * Agents do not drive the desktop themselves and never see passwords.
 */
export class ComputerUseWorker {
  private readonly jobs = new Map<string, ComputerUseHandle>();

  constructor(private readonly host: ComputerHost) {}

  async enqueue(task: ComputerUseTask): Promise<ComputerUseHandle> {
    const desktop = this.host.desktopOf(task.tenantId, task.agentId);
    if (!desktop) {
      throw new FailClosedError("DESKTOP_MISSING", "Agent has no desktop on the tenant computer.");
    }
    const handle: ComputerUseHandle = {
      id: newId("cu"),
      status: desktop.mode === "architect_control" ? "paused_for_architect" : "queued",
      note:
        desktop.mode === "architect_control"
          ? "Architect has the desktop. Worker is paused. Agent never sees keystrokes or passwords."
          : "Queued for the computer-use worker. Agent cannot drive X11 or the browser.",
    };
    this.jobs.set(handle.id, handle);
    if (handle.status === "queued") {
      handle.status = "running";
      handle.note = `Worker attached to display :${desktop.display} for goal: ${task.goal}`;
    }
    return handle;
  }

  async pauseForArchitect(jobId: string): Promise<ComputerUseHandle> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new FailClosedError("WORKER_JOB_MISSING", "Computer-use job not found.");
    }
    job.status = "paused_for_architect";
    job.note = "Architect takeover. Login, 2FA, captcha, and payment stay with the architect.";
    return job;
  }
}
