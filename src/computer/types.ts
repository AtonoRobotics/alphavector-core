export interface ComputerInstance {
  tenantId: string;
  containerName: string;
  volumeName: string;
  image: string;
  imageVersion: string;
  status: "running" | "stopped";
}

export interface DesktopSession {
  tenantId: string;
  agentId: string;
  display: number;
  width: number;
  height: number;
  vncPort: number;
  mode: "agent_watch" | "architect_control";
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  cwd: string;
}

export interface StructuredFile {
  path: string;
  exists: boolean;
  type: "file" | "directory" | "missing" | "other";
  size: number;
  encoding: "utf-8" | "base64";
  sha256?: string;
  content?: string;
  truncated: boolean;
}

export interface Screenshot {
  agentId: string;
  display: number;
  mime: "image/png";
  png: Buffer;
}

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

export interface ImageUpdateResult {
  tenantId: string;
  previousImage: string;
  nextImage: string;
  volumePreserved: true;
  samplePath: string;
  sampleStillPresent: boolean;
}

export interface EgressBinding {
  hosts: string[];
}
