import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { ComputerError } from "../errors.js";
import type { DesktopSession } from "./types.js";

const execFileAsync = promisify(execFile);

export function displayForAgent(agentId: string): number {
  let n = 10;
  for (let i = 0; i < agentId.length; i += 1) n = (n + agentId.charCodeAt(i) * (i + 1)) % 90;
  return 10 + n;
}

export function colorForDisplay(display: number): string {
  const r = 16 + ((display * 37) % 200);
  const g = 32 + ((display * 53) % 180);
  const b = 64 + ((display * 19) % 160);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Real per-agent desktop: Xvfb + labeled window + optional VNC.
 * Agents share the tenant disk, not this screen.
 */
export async function ensureRealDesktop(input: {
  tenantId: string;
  agentId: string;
  desktopPath: string;
}): Promise<DesktopSession> {
  if (!(await commandExists("Xvfb"))) {
    throw new ComputerError("DESKTOP_RUNTIME_MISSING", "Xvfb is required for a real per-agent desktop");
  }
  await mkdir(input.desktopPath, { recursive: true });
  const persisted = await readPersistedDisplay(input.desktopPath);
  const display = persisted ?? (await allocateDisplay(input.agentId));
  const vncPort = 5900 + display;
  const color = colorForDisplay(display);
  const env = { ...process.env, DISPLAY: `:${display}` };

  await ensureSpawned({
    pidFile: path.join(input.desktopPath, "xvfb.pid"),
    command: "Xvfb",
    args: [`:${display}`, "-screen", "0", "1280x720x24", "-ac", "-nolisten", "tcp"],
    ready: () => existsSync(`/tmp/.X11-unix/X${display}`),
  });
  await waitUntil(() => existsSync(`/tmp/.X11-unix/X${display}`), 40, 100);

  await execFileAsync("xsetroot", ["-solid", color], { env });
  await ensureSpawned({
    pidFile: path.join(input.desktopPath, "label.pid"),
    command: "xmessage",
    args: ["-center", `AV desktop\nagent=${input.agentId}\ndisplay=:${display}\ntenant=${input.tenantId}`],
    env,
  });

  if (await commandExists("x11vnc")) {
    await ensureSpawned({
      pidFile: path.join(input.desktopPath, "vnc.pid"),
      command: "x11vnc",
      args: [
        "-display",
        `:${display}`,
        "-rfbport",
        String(vncPort),
        "-forever",
        "-shared",
        "-nopw",
        "-localhost",
        "-quiet",
      ],
    });
  }

  const viewerPath = path.join(input.desktopPath, "viewer.html");
  await writeFile(
    viewerPath,
    architectViewerHtml({
      tenantId: input.tenantId,
      agentId: input.agentId,
      display,
      vncPort,
      color,
    }),
    "utf8",
  );
  await writeFile(path.join(input.desktopPath, "display"), `:${display}\n`, "utf8");
  await writeFile(
    path.join(input.desktopPath, "session.json"),
    `${JSON.stringify({ tenantId: input.tenantId, agentId: input.agentId, display, vncPort, color }, null, 2)}\n`,
    "utf8",
  );

  return {
    tenantId: input.tenantId,
    agentId: input.agentId,
    display,
    desktopPath: input.desktopPath,
    viewerPath,
    vncPort,
  };
}

export async function captureDesktopPng(display: number, desktopPath: string): Promise<Buffer> {
  if (!(await commandExists("scrot"))) {
    throw new ComputerError("DESKTOP_SCREENSHOT_MISSING", "scrot is required to screenshot a real desktop");
  }
  const dest = path.join(desktopPath, "screenshot.png");
  await execFileAsync("scrot", ["-o", dest], {
    env: { ...process.env, DISPLAY: `:${display}` },
    timeout: 10_000,
  });
  const bytes = await readFile(dest);
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new ComputerError("DESKTOP_SCREENSHOT_INVALID", "Screenshot was not a PNG");
  }
  return bytes;
}

export async function stopDesktop(desktopPath: string): Promise<void> {
  for (const name of ["vnc.pid", "label.pid", "xvfb.pid"]) {
    await killPidFile(path.join(desktopPath, name));
  }
}

async function ensureSpawned(input: {
  pidFile: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  ready?: () => boolean;
}): Promise<number> {
  const existing = await readPid(input.pidFile);
  if (existing && pidAlive(existing) && (!input.ready || input.ready())) {
    return existing;
  }
  const child = spawn(input.command, input.args, {
    detached: true,
    stdio: "ignore",
    env: input.env ?? process.env,
  });
  if (!child.pid) {
    throw new ComputerError("DESKTOP_SPAWN_FAILED", `Failed to start ${input.command}`);
  }
  child.unref();
  await writeFile(input.pidFile, `${child.pid}\n`, "utf8");
  return child.pid;
}

async function readPid(file: string): Promise<number | undefined> {
  try {
    const n = Number((await readFile(file, "utf8")).trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killPidFile(file: string): Promise<void> {
  const pid = await readPid(file);
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone
    }
  }
  try {
    await unlink(file);
  } catch {
    // absent
  }
}

async function readPersistedDisplay(desktopPath: string): Promise<number | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(desktopPath, "session.json"), "utf8")) as { display?: number };
    if (typeof raw.display === "number" && existsSync(`/tmp/.X11-unix/X${raw.display}`)) {
      return raw.display;
    }
    if (typeof raw.display === "number") return raw.display;
  } catch {
    // first start
  }
  return undefined;
}

async function allocateDisplay(agentId: string): Promise<number> {
  const preferred = displayForAgent(agentId);
  for (const candidate of [preferred, ...range(10, 199)]) {
    if (!existsSync(`/tmp/.X11-unix/X${candidate}`)) return candidate;
  }
  throw new ComputerError("DESKTOP_DISPLAY_EXHAUSTED", "No free X display for a per-agent desktop");
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

async function commandExists(name: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    try {
      await access(path.join(dir, name));
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

async function waitUntil(pred: () => boolean, tries: number, delayMs: number): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new ComputerError("DESKTOP_X_UNREADY", "Xvfb display did not become ready");
}

function architectViewerHtml(input: {
  tenantId: string;
  agentId: string;
  display: number;
  vncPort: number;
  color: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>AV Dev desktop · ${escapeHtml(input.agentId)}</title>
  <style>
    body { font: 15px/1.4 sans-serif; background: #111; color: #eee; margin: 1.5rem; }
    .screen { border: 4px solid ${input.color}; display: inline-block; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <h1>Architect attach</h1>
  <p>Tenant ${escapeHtml(input.tenantId)} · agent ${escapeHtml(input.agentId)} · display :${input.display}</p>
  <p>VNC localhost:${input.vncPort} (localhost only). Agent never sees keystrokes or passwords.</p>
  <div class="screen"><img src="screenshot.png" alt="agent desktop"/></div>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === '"') return "&quot;";
    return "&#39;";
  });
}
