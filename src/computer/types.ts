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
  /**
   * Architect-written skill files (agentskills SKILL.md). Worker or role-agent
   * reads them. Beside the disk, never inside the bind-mounted /home.
   */
  skillsDir: string;
  /**
   * Habitat-written skill/strategy proposals (HK-071). Not live skills.
   * Not policy. Beside the disk, never inside the bind-mounted /home.
   * loadSkillFiles does not read this directory.
   */
  proposalsDir: string;
  /**
   * Worker trailer isolation on the tenant disk (`/home/trailers`).
   * Torn down on worker_done / kill. Control book (workers.json) stays beside disk/.
   */
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
  /**
   * Habitat inter-agent mail (CS-018). Same class as routines / adapter-bind:
   * beside the disk, never inside the bind-mounted /home, never a field file.
   * In-process AgentMail is not this store.
   */
  mailFile: string;
  /**
   * Architect- or habitat-written deadlines. Same class as routines / mail:
   * beside the disk, never inside the bind-mounted /home, never a field file.
   * Not Temporal. The habitat clock fires due rows.
   */
  deadlinesFile: string;
  /**
   * Architect connector bind. Same class as adapter-bind / mail:
   * beside the disk, never inside the bind-mounted /home, never a field file.
   * In-process ConnectorBook is not this store. Not Temporal.
   */
  connectorBindFile: string;
  /**
   * Architect connector credentials. Same class as adapter-credentials:
   * beside the disk, never on connector-bind.json, never a field file.
   */
  connectorCredentialsFile: string;
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
  pid?: number;
}

/** Host-visible handle for a process left running inside the tenant machine. */
export interface HeldProcess {
  pid: number;
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
  /**
   * Run argv inside the tenant machine. Does not open a desktop.
   * Worker execution uses this, not a host Node child of the kernel.
   */
  execInMachine(req: ShellRequest): Promise<ShellResult>;
  /**
   * Start argv inside the tenant machine and leave it running.
   * Returns a host-visible pid for liveness / teardown. Not a host Node child doing the work.
   */
  spawnHeld(req: ShellRequest): Promise<HeldProcess>;
  readFile(tenantId: string, relPath: string): Promise<StructuredFile>;
  screenshot(tenantId: string, agentId: string): Promise<Screenshot>;
  writeSecret(tenantId: string, name: string, value: string): Promise<void>;
  architectAttach(tenantId: string, agentId: string): Promise<DesktopSession>;
  setEgress(tenantId: string, egress: EgressBinding): Promise<void>;
}
