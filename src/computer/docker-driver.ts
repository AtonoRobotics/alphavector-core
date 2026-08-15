import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { ComputerError } from "../errors.js";
import { captureDesktopPng, ensureRealDesktop, stopDesktop } from "./desktop.js";
import { assertSafeRelPath, computerRoot } from "./paths.js";
import { writeJsonAtomic } from "../persist/json-file.js";
import type {
  ComputerDriver,
  ComputerImage,
  DesktopSession,
  EgressBinding,
  Screenshot,
  ShellRequest,
  ShellResult,
  StructuredFile,
  TenantComputer,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Docker-hosted Linux computer. Same contracts as the namespace driver:
 * one container per tenant, persistent volume for the disk, per-agent desktops.
 * Used when a Docker engine is available (CI / production hosts).
 */
export class DockerComputerDriver implements ComputerDriver {
  readonly kind = "docker" as const;
  private readonly egress = new Map<string, EgressBinding>();

  constructor(
    private readonly baseDir: string,
    private readonly imageName = "alphavector/computer:dev",
  ) {}

  async start(tenantId: string): Promise<TenantComputer> {
    const paths = computerRoot(this.baseDir, tenantId);
    await mkdir(paths.disk, { recursive: true });
    await mkdir(paths.desktops, { recursive: true });
    await mkdir(paths.secrets, { recursive: true });
    await chmod(paths.secrets, 0o700);
    const name = this.containerName(tenantId);
    await this.removeIfExists(name);
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      name,
      "-v",
      `${paths.disk}:/home`,
      this.imageName,
      "sleep",
      "infinity",
    ]);
    await writeFile(path.join(paths.disk, ".tenant"), tenantId, "utf8");
    writeJsonAtomic(path.join(paths.root, "runtime.json"), {
      tenantId,
      status: "running",
      updatedAt: new Date().toISOString(),
    });
    return this.snapshot(tenantId, "running");
  }

  async stop(tenantId: string): Promise<void> {
    const paths = computerRoot(this.baseDir, tenantId);
    try {
      const { readdir } = await import("node:fs/promises");
      const agents = await readdir(paths.desktops);
      for (const agentId of agents) {
        await stopDesktop(path.join(paths.desktops, agentId));
      }
    } catch {
      // no desktops
    }
    await this.removeIfExists(this.containerName(tenantId));
    writeJsonAtomic(path.join(paths.root, "runtime.json"), {
      tenantId,
      status: "stopped",
      updatedAt: new Date().toISOString(),
    });
  }

  async status(tenantId: string): Promise<TenantComputer | undefined> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        this.containerName(tenantId),
      ]);
      if (stdout.trim() !== "true") return this.snapshot(tenantId, "stopped");
      return this.snapshot(tenantId, "running");
    } catch {
      return undefined;
    }
  }

  async updateImage(tenantId: string, image: ComputerImage): Promise<TenantComputer> {
    const paths = computerRoot(this.baseDir, tenantId);
    await this.stop(tenantId);
    await execFileAsync("docker", [
      "run",
      "-d",
      "--name",
      this.containerName(tenantId),
      "-v",
      `${paths.disk}:/home`,
      image.source,
      "sleep",
      "infinity",
    ]);
    await writeFile(path.join(paths.root, "image-id"), image.imageId, "utf8");
    return this.snapshot(tenantId, "running");
  }

  async resetFromSnapshot(tenantId: string, snapshotDir: string): Promise<TenantComputer> {
    throw new ComputerError(
      "RESET_LAST_RESORT",
      `Reset-from-snapshot is last resort; snapshot=${snapshotDir}`,
    );
  }

  async ensureDesktop(tenantId: string, agentId: string): Promise<DesktopSession> {
    const desktopPath = path.join(computerRoot(this.baseDir, tenantId).desktops, agentId);
    return ensureRealDesktop({ tenantId, agentId, desktopPath });
  }

  async shell(req: ShellRequest): Promise<ShellResult> {
    await this.ensureDesktop(req.tenantId, req.agentId);
    return this.exec(req.tenantId, req.argv, req.cwd ?? "/home");
  }

  async readFile(tenantId: string, relPath: string): Promise<StructuredFile> {
    const safe = assertSafeRelPath(relPath);
    const abs = path.join(computerRoot(this.baseDir, tenantId).disk, safe);
    try {
      const { stat } = await import("node:fs/promises");
      const st = await stat(abs);
      if (st.isDirectory()) return { path: safe, exists: true, type: "directory", size: 0 };
      const buf = await readFile(abs);
      return {
        path: safe,
        exists: true,
        type: "file",
        size: st.size,
        encoding: "utf8",
        content: buf.toString("utf8"),
      };
    } catch {
      return { path: safe, exists: false };
    }
  }

  async screenshot(tenantId: string, agentId: string): Promise<Screenshot> {
    const desktop = await this.ensureDesktop(tenantId, agentId);
    const bytes = await captureDesktopPng(desktop.display, desktop.desktopPath);
    return { agentId, display: desktop.display, mime: "image/png", bytes };
  }

  async writeSecret(tenantId: string, name: string, value: string): Promise<void> {
    const dest = path.join(computerRoot(this.baseDir, tenantId).secrets, path.basename(name));
    await writeFile(dest, value, { mode: 0o600 });
  }

  async architectAttach(tenantId: string, agentId: string): Promise<DesktopSession> {
    return this.ensureDesktop(tenantId, agentId);
  }

  async setEgress(tenantId: string, egress: EgressBinding): Promise<void> {
    this.egress.set(tenantId, egress);
  }

  private containerName(tenantId: string): string {
    return `av-computer-${tenantId}`;
  }

  private async exec(tenantId: string, argv: string[], cwd = "/home"): Promise<ShellResult> {
    try {
      const { stdout, stderr } = await execFileAsync("docker", [
        "exec",
        "-w",
        cwd,
        this.containerName(tenantId),
        ...argv,
      ]);
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "exec failed",
      };
    }
  }

  private async removeIfExists(name: string): Promise<void> {
    try {
      await execFileAsync("docker", ["rm", "-f", name]);
    } catch {
      // absent is fine
    }
  }

  private async snapshot(tenantId: string, status: "running" | "stopped"): Promise<TenantComputer> {
    const paths = computerRoot(this.baseDir, tenantId);
    let imageId = this.imageName;
    try {
      imageId = (await readFile(path.join(paths.root, "image-id"), "utf8")).trim();
    } catch {
      // default
    }
    return {
      tenantId,
      status,
      imageId,
      diskPath: paths.disk,
      sharedFilesystem: true,
    };
  }
}
