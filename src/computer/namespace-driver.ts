import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  cp,
} from "node:fs/promises";
import path from "node:path";
import { ComputerError } from "../errors.js";
import {
  DEFAULT_IMAGE_ID,
  ensureAlpineTarball,
  extractRootfs,
  readImageId,
  stampImage,
} from "./image.js";
import { assertSafeRelPath, computerRoot } from "./paths.js";
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
 * Real Linux-hosted computer: Alpine rootfs + unshare namespaces + persistent disk.
 * One machine per tenant. Agents share the disk. Desktops are per-agent.
 * Image update replaces rootfs and keeps /home (disk) and browser profiles.
 */
export class NamespaceComputerDriver implements ComputerDriver {
  readonly kind = "namespace" as const;
  private readonly running = new Set<string>();
  private readonly egress = new Map<string, EgressBinding>();
  private rootfsTemplate: string | undefined;

  constructor(
    private readonly baseDir: string,
    private readonly imageCacheDir: string,
  ) {}

  async prepareTemplate(imageId = DEFAULT_IMAGE_ID): Promise<string> {
    if (this.rootfsTemplate) return this.rootfsTemplate;
    const tarball = await ensureAlpineTarball(this.imageCacheDir);
    const template = path.join(this.baseDir, "images", imageId);
    try {
      await readFile(path.join(template, "etc", "av-image-id"), "utf8");
    } catch {
      await extractRootfs(tarball, template);
      await stampImage(template, imageId);
    }
    this.rootfsTemplate = template;
    return template;
  }

  async start(tenantId: string): Promise<TenantComputer> {
    const paths = computerRoot(this.baseDir, tenantId);
    await mkdir(paths.disk, { recursive: true });
    await mkdir(paths.desktops, { recursive: true });
    await mkdir(paths.secrets, { recursive: true });
    await chmod(paths.secrets, 0o700);
    const template = await this.prepareTemplate();
    try {
      await readFile(paths.imageIdFile, "utf8");
    } catch {
      await this.materializeRootfs(template, paths.rootfs);
      await writeFile(paths.imageIdFile, DEFAULT_IMAGE_ID, "utf8");
    }
    await writeFile(path.join(paths.disk, ".tenant"), tenantId, "utf8");
    this.running.add(tenantId);
    return this.snapshot(tenantId);
  }

  async stop(tenantId: string): Promise<void> {
    this.running.delete(tenantId);
  }

  async status(tenantId: string): Promise<TenantComputer | undefined> {
    if (!this.running.has(tenantId)) return undefined;
    return this.snapshot(tenantId);
  }

  async updateImage(tenantId: string, image: ComputerImage): Promise<TenantComputer> {
    const paths = computerRoot(this.baseDir, tenantId);
    const wasRunning = this.running.has(tenantId);
    if (wasRunning) await this.stop(tenantId);
    const next = `${paths.rootfs}.next`;
    if (image.source.endsWith(".tar.gz") || image.source.endsWith(".tgz")) {
      await extractRootfs(image.source, next);
    } else {
      await rm(next, { recursive: true, force: true });
      await cp(image.source, next, { recursive: true });
    }
    await stampImage(next, image.imageId);
    await rm(paths.rootfs, { recursive: true, force: true });
    await rename(next, paths.rootfs);
    await writeFile(paths.imageIdFile, image.imageId, "utf8");
    if (wasRunning) this.running.add(tenantId);
    return this.snapshot(tenantId);
  }

  async resetFromSnapshot(tenantId: string, snapshotDir: string): Promise<TenantComputer> {
    const paths = computerRoot(this.baseDir, tenantId);
    await rm(paths.disk, { recursive: true, force: true });
    await cp(snapshotDir, paths.disk, { recursive: true });
    await mkdir(paths.desktops, { recursive: true });
    await mkdir(paths.secrets, { recursive: true });
    return this.snapshot(tenantId);
  }

  async ensureDesktop(tenantId: string, agentId: string): Promise<DesktopSession> {
    await this.requireRunning(tenantId);
    const paths = computerRoot(this.baseDir, tenantId);
    const display = this.displayFor(agentId);
    const desktopPath = path.join(paths.desktops, agentId);
    await mkdir(desktopPath, { recursive: true });
    const screen = `AV desktop agent=${agentId} display=:${display} tenant=${tenantId}\n`;
    await writeFile(path.join(desktopPath, "screen.txt"), screen, "utf8");
    await writeFile(path.join(desktopPath, "display"), `:${display}\n`, "utf8");
    return { tenantId, agentId, display, desktopPath };
  }

  async shell(req: ShellRequest): Promise<ShellResult> {
    await this.requireRunning(req.tenantId);
    const paths = computerRoot(this.baseDir, req.tenantId);
    await this.ensureDesktop(req.tenantId, req.agentId);
    const script = this.wrapCommand(req);
    try {
      const { stdout, stderr } = await execFileAsync(
        "unshare",
        [
          "--map-root-user",
          "--mount",
          "--uts",
          "--pid",
          "--fork",
          "--kill-child",
          "/bin/bash",
          "-c",
          script,
        ],
        {
          cwd: paths.disk,
          timeout: 30_000,
          maxBuffer: 2_000_000,
          env: {
            PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
            HOME: "/home",
            AV_TENANT: req.tenantId,
            AV_AGENT: req.agentId,
          },
        },
      );
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "shell failed",
      };
    }
  }

  async readFile(tenantId: string, relPath: string): Promise<StructuredFile> {
    await this.requireRunning(tenantId);
    const safe = assertSafeRelPath(relPath);
    const paths = computerRoot(this.baseDir, tenantId);
    const abs = path.join(paths.disk, safe);
    try {
      const st = await stat(abs);
      if (st.isDirectory()) {
        return { path: safe, exists: true, type: "directory", size: 0 };
      }
      const buf = await readFile(abs);
      const utf8 = buf.toString("utf8");
      const binary = /[\x00-\x08]/.test(utf8);
      return {
        path: safe,
        exists: true,
        type: "file",
        size: st.size,
        encoding: binary ? "binary" : "utf8",
        content: binary ? undefined : utf8,
      };
    } catch {
      return { path: safe, exists: false };
    }
  }

  async screenshot(tenantId: string, agentId: string): Promise<Screenshot> {
    const desktop = await this.ensureDesktop(tenantId, agentId);
    const bytes = await readFile(path.join(desktop.desktopPath, "screen.txt"));
    return { agentId, display: desktop.display, mime: "text/plain", bytes };
  }

  async writeSecret(tenantId: string, name: string, value: string): Promise<void> {
    const paths = computerRoot(this.baseDir, tenantId);
    await mkdir(paths.secrets, { recursive: true });
    const dest = path.join(paths.secrets, path.basename(name));
    await writeFile(dest, value, { mode: 0o600 });
  }

  async architectAttach(tenantId: string, agentId: string): Promise<DesktopSession> {
    return this.ensureDesktop(tenantId, agentId);
  }

  async setEgress(tenantId: string, egress: EgressBinding): Promise<void> {
    this.egress.set(tenantId, egress);
    const paths = computerRoot(this.baseDir, tenantId);
    await writeFile(path.join(paths.disk, ".egress.json"), JSON.stringify(egress), "utf8");
  }

  private async snapshot(tenantId: string): Promise<TenantComputer> {
    const paths = computerRoot(this.baseDir, tenantId);
    let imageId = DEFAULT_IMAGE_ID;
    try {
      imageId = (await readFile(paths.imageIdFile, "utf8")).trim();
    } catch {
      imageId = await readImageId(paths.rootfs);
    }
    return {
      tenantId,
      status: this.running.has(tenantId) ? "running" : "stopped",
      imageId,
      diskPath: paths.disk,
      sharedFilesystem: true,
    };
  }

  private async requireRunning(tenantId: string): Promise<void> {
    if (!this.running.has(tenantId)) {
      throw new ComputerError("COMPUTER_NOT_RUNNING", `Computer for tenant ${tenantId} is not running`);
    }
  }

  private displayFor(agentId: string): number {
    let n = 10;
    for (let i = 0; i < agentId.length; i += 1) n = (n + agentId.charCodeAt(i) * (i + 1)) % 90;
    return 10 + n;
  }

  private async materializeRootfs(template: string, dest: string): Promise<void> {
    await rm(dest, { recursive: true, force: true });
    await cp(template, dest, { recursive: true });
  }

  private wrapCommand(req: ShellRequest): string {
    const paths = computerRoot(this.baseDir, req.tenantId);
    const quoted = req.argv.map(shQuote).join(" ");
    const cwd = req.cwd ? shQuote(req.cwd) : "/home";
    return [
      `set -euo pipefail`,
      `mount --bind ${shQuote(paths.disk)} ${shQuote(path.join(paths.rootfs, "home"))}`,
      `hostname ${shQuote(`av-${req.tenantId.slice(0, 12)}`)}`,
      `export DISPLAY=:${this.displayFor(req.agentId)}`,
      `export AV_AGENT=${shQuote(req.agentId)}`,
      `unshare --root ${shQuote(paths.rootfs)} --wd ${cwd} /bin/sh -c ${shQuote(quoted)}`,
    ].join("\n");
  }
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function listDesktopAgents(baseDir: string, tenantId: string): Promise<string[]> {
  const paths = computerRoot(baseDir, tenantId);
  try {
    return await readdir(paths.desktops);
  } catch {
    return [];
  }
}
