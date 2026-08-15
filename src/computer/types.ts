export interface ComputerPaths {
  root: string;
  disk: string;
  rootfs: string;
  desktops: string;
  secrets: string;
  secretOverlay: string;
  imageIdFile: string;
  egressFile: string;
  /** Authorization cards. Beside the disk, never inside the bind-mounted /home. */
  cardsFile: string;
  /** Tenant-issued field and Architect credentials. Beside secrets and cards, never inside disk/. */
  fieldTokensFile: string;
  /** Generic tenant facts for pack predicates. Beside cards and tokens, never inside disk/. */
  factsFile: string;
}

export interface TenantComputer {
  tenantId: string;
  status: "running" | "stopped";
  imageId: string;
  diskPath: string;
  sharedFilesystem: true;
}

export interface DesktopSession {
  tenantId: string;
  agentId: string;
  display: number;
  desktopPath: string;
  viewerPath: string;
  vncPort: number;
}

export interface ShellRequest {
  tenantId: string;
  agentId: string;
  argv: string[];
  cwd?: string;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface StructuredFile {
  path: string;
  exists: boolean;
  type?: "file" | "directory";
  size?: number;
  encoding?: "utf8" | "binary";
  content?: string;
}

export interface Screenshot {
  agentId: string;
  display: number;
  mime: "image/png" | "text/plain";
  bytes: Buffer;
}

export interface ComputerImage {
  imageId: string;
  source: string;
}

export interface EgressBinding {
  allowHosts: string[];
}

export interface ComputerDriver {
  readonly kind: "namespace" | "docker";
  start(tenantId: string): Promise<TenantComputer>;
  stop(tenantId: string): Promise<void>;
  status(tenantId: string): Promise<TenantComputer | undefined>;
  updateImage(tenantId: string, image: ComputerImage): Promise<TenantComputer>;
  resetFromSnapshot(tenantId: string, snapshotDir: string): Promise<TenantComputer>;
  ensureDesktop(tenantId: string, agentId: string): Promise<DesktopSession>;
  shell(req: ShellRequest): Promise<ShellResult>;
  readFile(tenantId: string, relPath: string): Promise<StructuredFile>;
  screenshot(tenantId: string, agentId: string): Promise<Screenshot>;
  writeSecret(tenantId: string, name: string, value: string): Promise<void>;
  architectAttach(tenantId: string, agentId: string): Promise<DesktopSession>;
  setEgress(tenantId: string, egress: EgressBinding): Promise<void>;
}
