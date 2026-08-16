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
  /** Generic subject records facts attach to. Beside facts, cards, and tokens, never inside disk/. */
  recordsFile: string;
  /** Habitat run records. Control state, beside cards.json, never inside disk/. */
  runsFile: string;
  /** Habitat worker book. Control state, beside runs.json, never a business fact. */
  workersFile: string;
  /** Replayable wake log. Beside runs.json, never inside disk/. */
  wakeLogFile: string;
  /** CS-012 disk memory (profile, dated logs, scoped recall). Not the in-process MemoryTiers array. */
  memoryDir: string;
  /** Pack skill files the worker or role-agent can read. */
  skillsDir: string;
  /** Worker trailer isolation. Torn down on worker_done / kill. */
  trailersDir: string;
  /**
   * Architect adapter bind (HK-055). Same class as field-tokens / credentials.
   * Beside the disk, never inside the bind-mounted /home, never a field file.
   */
  adapterBindFile: string;
  /**
   * Architect provider credentials. Same class as field-tokens / adapter-bind.
   * Beside the disk, never inside the bind-mounted /home, never on adapter-bind.json.
   */
  adapterCredentialsFile: string;
  /**
   * Architect- or pack-written routines (CS-013). Same class as adapter-bind:
   * beside the disk, never inside the bind-mounted /home, never a field file.
   * Pack declaration is not live until stored here.
   */
  routinesFile: string;
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
