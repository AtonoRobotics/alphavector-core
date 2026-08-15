import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FailClosedError } from "../errors.js";
import { PRODUCT } from "../product.js";
import { assertArchitect, assertSameTenant } from "../principals/guard.js";
import type { Principal } from "../principals/types.js";
import { DockerError, dockerAvailable, ProcessDockerRunner, type DockerRunner } from "./docker.js";
import { encodeEgressEnv } from "./egress.js";
import type {
  ComputerInstance,
  DesktopSession,
  EgressBinding,
  ImageUpdateResult,
  Screenshot,
  ShellResult,
  StructuredFile,
} from "./types.js";

const DISPLAY_BASE = 10;
const DESKTOP_WIDTH = 1280;
const DESKTOP_HEIGHT = 720;

export interface ComputerHostOptions {
  runner?: DockerRunner;
  image?: string;
  imageVersion?: string;
  dockerfileDir?: string;
}

export class ComputerHost {
  private readonly runner: DockerRunner;
  private readonly image: string;
  private readonly imageVersion: string;
  private readonly dockerfileDir: string;
  private readonly computers = new Map<string, ComputerInstance>();
  private readonly desktops = new Map<string, DesktopSession>();
  private imageReady = false;

  constructor(options: ComputerHostOptions = {}) {
    this.runner = options.runner ?? new ProcessDockerRunner();
    this.image = options.image ?? PRODUCT.computerImage;
    this.imageVersion = options.imageVersion ?? PRODUCT.computerImageVersion;
    this.dockerfileDir =
      options.dockerfileDir ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../computer/image");
  }

  imageRef(version = this.imageVersion): string {
    return `${this.image}:${version}`;
  }

  async ensureImage(version = this.imageVersion): Promise<string> {
    if (!(await dockerAvailable(this.runner))) {
      throw new FailClosedError("COMPUTER_RUNTIME_MISSING", "Docker is required to host the Linux computer.");
    }
    const ref = this.imageRef(version);
    try {
      await this.runner.run(["image", "inspect", ref], { timeoutMs: 15_000 });
      this.imageReady = true;
      return ref;
    } catch {
      if (!existsSync(path.join(this.dockerfileDir, "Dockerfile"))) {
        throw new FailClosedError("COMPUTER_IMAGE_MISSING", `Computer Dockerfile not found in ${this.dockerfileDir}`);
      }
      await this.runner.run(["build", "-t", ref, "-f", "Dockerfile", "."], {
        timeoutMs: 600_000,
        cwd: this.dockerfileDir,
      });
      this.imageReady = true;
      return ref;
    }
  }

  async startTenantComputer(input: {
    tenantId: string;
    egress: EgressBinding;
    imageVersion?: string;
    replace?: boolean;
  }): Promise<ComputerInstance> {
    const existing = this.computers.get(input.tenantId);
    if (existing?.status === "running" && !input.replace) {
      return existing;
    }
    const version = input.imageVersion ?? this.imageVersion;
    const image = await this.ensureImage(version);
    const volumeName = volumeFor(input.tenantId);
    const containerName = containerFor(input.tenantId);
    await this.runner.run(["volume", "create", volumeName]);
    await this.removeContainerIfExists(containerName);
    await this.runner.run([
      "run",
      "-d",
      "--name",
      containerName,
      "--label",
      `${PRODUCT.bundle}/component=computer`,
      "--label",
      `${PRODUCT.bundle}/tenant=${input.tenantId}`,
      "-e",
      `AV_TENANT_ID=${input.tenantId}`,
      "-e",
      `AV_EGRESS_HOSTS=${encodeEgressEnv(input.egress)}`,
      "-v",
      `${volumeName}:/tenant`,
      "--tmpfs",
      "/tmp:rw,exec,mode=1777",
      image,
    ]);
    await this.waitHealthy(containerName);
    const instance: ComputerInstance = {
      tenantId: input.tenantId,
      containerName,
      volumeName,
      image: this.image,
      imageVersion: version,
      status: "running",
    };
    this.computers.set(input.tenantId, instance);
    return instance;
  }

  async attachDesktop(tenantId: string, agentId: string): Promise<DesktopSession> {
    const computer = this.requireComputer(tenantId);
    const key = desktopKey(tenantId, agentId);
    const existing = this.desktops.get(key);
    if (existing) {
      return existing;
    }
    const used = [...this.desktops.values()]
      .filter((item) => item.tenantId === tenantId)
      .map((item) => item.display);
    let display = DISPLAY_BASE;
    while (used.includes(display)) {
      display += 1;
    }
    const vncPort = 5900 + display;
    await this.cli(computer, ["desktop-start", agentId, String(display), String(DESKTOP_WIDTH), String(DESKTOP_HEIGHT)]);
    const session: DesktopSession = {
      tenantId,
      agentId,
      display,
      width: DESKTOP_WIDTH,
      height: DESKTOP_HEIGHT,
      vncPort,
      mode: "agent_watch",
    };
    this.desktops.set(key, session);
    return session;
  }

  desktopOf(tenantId: string, agentId: string): DesktopSession | undefined {
    return this.desktops.get(desktopKey(tenantId, agentId));
  }

  async execShell(tenantId: string, agentId: string, command: string, cwd = "/tenant/home"): Promise<ShellResult> {
    this.requireComputer(tenantId);
    this.requireDesktop(tenantId, agentId);
    const raw = await this.cli(this.requireComputer(tenantId), ["shell", cwd, command]);
    const parsed = JSON.parse(raw) as ShellResult;
    return parsed;
  }

  async readFile(tenantId: string, filePath: string, maxBytes = 64_000): Promise<StructuredFile> {
    this.requireComputer(tenantId);
    if (!filePath.startsWith("/tenant/")) {
      throw new FailClosedError("FILE_PATH_DENIED", "Agents may only read the tenant disk under /tenant.");
    }
    const raw = await this.cli(this.requireComputer(tenantId), ["files-read", filePath, String(maxBytes)]);
    return JSON.parse(raw) as StructuredFile;
  }

  async writeTenantFile(tenantId: string, filePath: string, content: string): Promise<void> {
    if (!filePath.startsWith("/tenant/")) {
      throw new FailClosedError("FILE_PATH_DENIED", "Writes stay on the tenant disk under /tenant.");
    }
    const computer = this.requireComputer(tenantId);
    const encoded = Buffer.from(content, "utf8").toString("base64");
    await this.cli(computer, ["files-write", filePath, encoded]);
  }

  async screenshot(tenantId: string, agentId: string): Promise<Screenshot> {
    const desktop = this.requireDesktop(tenantId, agentId);
    const raw = await this.cli(this.requireComputer(tenantId), ["screenshot", String(desktop.display)]);
    const parsed = JSON.parse(raw) as { png_base64: string };
    return {
      agentId,
      display: desktop.display,
      mime: "image/png",
      png: Buffer.from(parsed.png_base64, "base64"),
    };
  }

  async architectOpen(principal: Principal, tenantId: string, agentId: string): Promise<DesktopSession> {
    assertSameTenant(principal, tenantId);
    assertArchitect(principal, "open a tenant desktop");
    return this.attachDesktop(tenantId, agentId);
  }

  async architectTakeover(principal: Principal, tenantId: string, agentId: string): Promise<DesktopSession> {
    assertSameTenant(principal, tenantId);
    assertArchitect(principal, "take over a desktop for login, 2FA, captcha, or payment");
    const desktop = await this.attachDesktop(tenantId, agentId);
    desktop.mode = "architect_control";
    this.desktops.set(desktopKey(tenantId, agentId), desktop);
    return desktop;
  }

  async updateImage(tenantId: string, nextVersion: string, egress: EgressBinding): Promise<ImageUpdateResult> {
    const previous = this.requireComputer(tenantId);
    const samplePath = "/tenant/home/.av-persist-check";
    const existing = await this.readFile(tenantId, samplePath);
    const sample =
      existing.exists && existing.content
        ? existing.content
        : `persist-${tenantId}-${Date.now()}`;
    if (!existing.exists || existing.content !== sample) {
      await this.writeTenantFile(tenantId, samplePath, sample);
    }
    const nextImage = await this.ensureImage(nextVersion);
    await this.startTenantComputer({ tenantId, egress, imageVersion: nextVersion, replace: true });
    for (const [key, desktop] of [...this.desktops.entries()]) {
      if (desktop.tenantId === tenantId) {
        this.desktops.delete(key);
        await this.attachDesktop(tenantId, desktop.agentId);
      }
    }
    const after = await this.readFile(tenantId, samplePath);
    return {
      tenantId,
      previousImage: `${previous.image}:${previous.imageVersion}`,
      nextImage,
      volumePreserved: true,
      samplePath,
      sampleStillPresent: after.exists && after.content === sample,
    };
  }

  async resetFromSnapshot(principal: Principal, tenantId: string, snapshotVolume: string): Promise<void> {
    assertSameTenant(principal, tenantId);
    assertArchitect(principal, "reset a computer from snapshot");
    const computer = this.requireComputer(tenantId);
    await this.runner.run(["rm", "-f", computer.containerName]);
    await this.runner.run(["volume", "rm", "-f", computer.volumeName]);
    await this.runner.run(["volume", "create", "--name", computer.volumeName]);
    await this.runner.run([
      "run",
      "--rm",
      "-v",
      `${snapshotVolume}:/from:ro`,
      "-v",
      `${computer.volumeName}:/to`,
      this.imageRef(computer.imageVersion),
      "bash",
      "-lc",
      "cp -a /from/. /to/",
    ]);
    computer.status = "stopped";
    this.computers.set(tenantId, computer);
  }

  async stopTenant(tenantId: string): Promise<void> {
    const computer = this.computers.get(tenantId);
    if (!computer) {
      return;
    }
    await this.removeContainerIfExists(computer.containerName);
    computer.status = "stopped";
    for (const [key, desktop] of this.desktops) {
      if (desktop.tenantId === tenantId) {
        this.desktops.delete(key);
      }
    }
  }

  async destroyTenant(tenantId: string): Promise<void> {
    await this.stopTenant(tenantId);
    const volume = volumeFor(tenantId);
    try {
      await this.runner.run(["volume", "rm", "-f", volume]);
    } catch (error) {
      if (!(error instanceof DockerError)) {
        throw error;
      }
    }
    this.computers.delete(tenantId);
  }

  screenshotDigest(shot: Screenshot): string {
    return createHash("sha256").update(shot.png).digest("hex");
  }

  private requireComputer(tenantId: string): ComputerInstance {
    const computer = this.computers.get(tenantId);
    if (!computer || computer.status !== "running") {
      throw new FailClosedError("COMPUTER_NOT_RUNNING", "Tenant computer is not running.");
    }
    return computer;
  }

  private requireDesktop(tenantId: string, agentId: string): DesktopSession {
    const desktop = this.desktops.get(desktopKey(tenantId, agentId));
    if (!desktop) {
      throw new FailClosedError("DESKTOP_MISSING", "Attach a desktop before using screenshot or shell context.");
    }
    return desktop;
  }

  private async cli(computer: ComputerInstance, args: string[]): Promise<string> {
    const result = await this.runner.run(["exec", computer.containerName, "/opt/av-computer/bin/av-computer-cli", ...args], {
      timeoutMs: 60_000,
    });
    return result.stdout.trim();
  }

  private async waitHealthy(containerName: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const result = await this.runner.run(["exec", containerName, "/opt/av-computer/bin/av-computer-cli", "health"], {
          timeoutMs: 5_000,
        });
        if (result.stdout.includes("ok")) {
          return;
        }
      } catch {
        await sleep(250);
      }
    }
    throw new FailClosedError("COMPUTER_UNHEALTHY", "Tenant computer did not become healthy.");
  }

  private async removeContainerIfExists(name: string): Promise<void> {
    try {
      await this.runner.run(["rm", "-f", name], { timeoutMs: 30_000 });
    } catch (error) {
      if (!(error instanceof DockerError)) {
        throw error;
      }
    }
  }

  get ready(): boolean {
    return this.imageReady;
  }
}

function containerFor(tenantId: string): string {
  return `av-computer-${safe(tenantId)}`;
}

function volumeFor(tenantId: string): string {
  return `av-tenant-disk-${safe(tenantId)}`;
}

function desktopKey(tenantId: string, agentId: string): string {
  return `${tenantId}:${agentId}`;
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
