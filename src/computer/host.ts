import { access } from "node:fs/promises";
import { ComputerError } from "../errors.js";
import { DockerComputerDriver } from "./docker-driver.js";
import { NamespaceComputerDriver } from "./namespace-driver.js";
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

export interface ComputerHostOptions {
  baseDir: string;
  imageCacheDir: string;
  preferDocker?: boolean;
}

/**
 * Tenant computer host. One persistent Linux computer per tenant.
 * Agents share the machine (disk, tools, browser logins). Desktops are per-agent.
 * Packs may bind egress. Packs do not own the computer.
 * Field users do not configure hypervisor, images, or networking.
 */
export class ComputerHost {
  readonly driver: ComputerDriver;

  constructor(driver: ComputerDriver) {
    this.driver = driver;
  }

  static async create(opts: ComputerHostOptions): Promise<ComputerHost> {
    if (opts.preferDocker && (await dockerAvailable())) {
      return new ComputerHost(new DockerComputerDriver(opts.baseDir));
    }
    const ns = new NamespaceComputerDriver(opts.baseDir, opts.imageCacheDir);
    await ns.prepareTemplate();
    return new ComputerHost(ns);
  }

  start(tenantId: string): Promise<TenantComputer> {
    return this.driver.start(tenantId);
  }

  stop(tenantId: string): Promise<void> {
    return this.driver.stop(tenantId);
  }

  updateImage(tenantId: string, image: ComputerImage): Promise<TenantComputer> {
    return this.driver.updateImage(tenantId, image);
  }

  resetFromSnapshot(tenantId: string, snapshotDir: string): Promise<TenantComputer> {
    return this.driver.resetFromSnapshot(tenantId, snapshotDir);
  }

  ensureDesktop(tenantId: string, agentId: string): Promise<DesktopSession> {
    return this.driver.ensureDesktop(tenantId, agentId);
  }

  shell(req: ShellRequest): Promise<ShellResult> {
    return this.driver.shell(req);
  }

  readFile(tenantId: string, relPath: string): Promise<StructuredFile> {
    if (relPath.replace(/\\/g, "/").includes(".secrets")) {
      return Promise.reject(new ComputerError("SECRET_DENIED", "Agent never sees passwords or secrets"));
    }
    return this.driver.readFile(tenantId, relPath);
  }

  screenshot(tenantId: string, agentId: string): Promise<Screenshot> {
    return this.driver.screenshot(tenantId, agentId);
  }

  writeSecret(tenantId: string, name: string, value: string): Promise<void> {
    return this.driver.writeSecret(tenantId, name, value);
  }

  architectAttach(tenantId: string, agentId: string): Promise<DesktopSession> {
    return this.driver.architectAttach(tenantId, agentId);
  }

  setEgress(tenantId: string, egress: EgressBinding): Promise<void> {
    return this.driver.setEgress(tenantId, egress);
  }
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await access("/usr/bin/docker");
    return true;
  } catch {
    return false;
  }
}
