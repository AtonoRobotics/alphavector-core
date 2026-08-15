import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { promisify } from "node:util";
import { ComputerError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface TenantNetPlan {
  id: string;
  netns: string;
  hostIface: string;
  guestIface: string;
  gatewayIp: string;
  guestIp: string;
  comment: string;
}

export interface AllowTarget {
  host: string;
  ip: string;
  port?: number;
}

/**
 * Deterministic per-tenant net plan. `baseDir` is part of the hash so two
 * computers with the same tenant id do not share a netns or veth.
 */
export function planTenantNet(baseDir: string, tenantId: string): TenantNetPlan {
  const id = createHash("sha256").update(baseDir).update("\0").update(tenantId).digest("hex").slice(0, 8);
  const n = Number.parseInt(id.slice(0, 4), 16) % 16384;
  const network = n * 4;
  const o2 = (network >>> 8) & 0xff;
  const o3 = network & 0xff;
  return {
    id,
    netns: `av${id}`,
    hostIface: `avh${id}`,
    guestIface: `avg${id}`,
    gatewayIp: `10.201.${o2}.${o3 + 1}`,
    guestIp: `10.201.${o2}.${o3 + 2}`,
    comment: `av-e-${id}`,
  };
}

export function parseAllowHost(entry: string): { host: string; port?: number } {
  const trimmed = entry.trim();
  if (!trimmed) {
    throw new ComputerError("EGRESS_INVALID", "Empty allow host");
  }
  const v4 = trimmed.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
  if (v4?.[1]) {
    return { host: v4[1], port: v4[2] ? Number(v4[2]) : undefined };
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(trimmed.slice(lastColon + 1))) {
    return { host: trimmed.slice(0, lastColon), port: Number(trimmed.slice(lastColon + 1)) };
  }
  return { host: trimmed };
}

export async function resolveAllowHost(entry: string): Promise<AllowTarget> {
  const parsed = parseAllowHost(entry);
  const dotted = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.host);
  const ip = dotted ? parsed.host : (await lookup(parsed.host, { family: 4 })).address;
  return { host: parsed.host, ip, port: parsed.port };
}

export async function netnsExists(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("sudo", ["-n", "ip", "netns", "list"], { timeout: 8_000 });
    return stdout.split("\n").some((line) => line.split(/\s+/)[0] === name);
  } catch {
    return false;
  }
}

export async function applyTenantNet(plan: TenantNetPlan, allowHosts: string[]): Promise<void> {
  if (allowHosts.length === 0) {
    await teardownTenantNet(plan);
    return;
  }
  await teardownTenantNet(plan);
  const targets = await Promise.all(allowHosts.map(resolveAllowHost));
  await sudo(["ip", "netns", "add", plan.netns]);
  try {
    await sudo(["ip", "link", "add", plan.hostIface, "type", "veth", "peer", "name", plan.guestIface]);
    await sudo(["ip", "link", "set", plan.guestIface, "netns", plan.netns]);
    await sudo(["ip", "addr", "add", `${plan.gatewayIp}/30`, "dev", plan.hostIface]);
    await sudo(["ip", "link", "set", plan.hostIface, "up"]);
    await sudo(["ip", "netns", "exec", plan.netns, "ip", "addr", "add", `${plan.guestIp}/30`, "dev", plan.guestIface]);
    await sudo(["ip", "netns", "exec", plan.netns, "ip", "link", "set", plan.guestIface, "up"]);
    await sudo(["ip", "netns", "exec", plan.netns, "ip", "link", "set", "lo", "up"]);
    await sudo(["ip", "netns", "exec", plan.netns, "ip", "route", "add", "default", "via", plan.gatewayIp]);
    await sudo(["sysctl", "-w", "net.ipv4.ip_forward=1"]);

    // Insert DROP first so later ACCEPTs sit above it.
    await iptables(["-I", "INPUT", "-i", plan.hostIface, "-m", "comment", "--comment", plan.comment, "-j", "DROP"]);
    await iptables(["-I", "FORWARD", "-i", plan.hostIface, "-m", "comment", "--comment", plan.comment, "-j", "DROP"]);
    await iptables([
      "-I",
      "INPUT",
      "-i",
      plan.hostIface,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-m",
      "comment",
      "--comment",
      plan.comment,
      "-j",
      "ACCEPT",
    ]);
    await iptables([
      "-I",
      "FORWARD",
      "-i",
      plan.hostIface,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-m",
      "comment",
      "--comment",
      plan.comment,
      "-j",
      "ACCEPT",
    ]);
    for (const target of targets) {
      const destPort = target.port != null ? ["-p", "tcp", "--dport", String(target.port)] : ["-p", "tcp"];
      await iptables([
        "-I",
        "INPUT",
        "-i",
        plan.hostIface,
        "-d",
        target.ip,
        ...destPort,
        "-m",
        "comment",
        "--comment",
        plan.comment,
        "-j",
        "ACCEPT",
      ]);
      await iptables([
        "-I",
        "FORWARD",
        "-i",
        plan.hostIface,
        "-d",
        target.ip,
        ...destPort,
        "-m",
        "comment",
        "--comment",
        plan.comment,
        "-j",
        "ACCEPT",
      ]);
    }
    await sudo([
      "iptables",
      "-t",
      "nat",
      "-I",
      "POSTROUTING",
      "-s",
      `${plan.guestIp}/32`,
      "-m",
      "comment",
      "--comment",
      plan.comment,
      "-j",
      "MASQUERADE",
    ]);
  } catch (err) {
    await teardownTenantNet(plan);
    throw err;
  }
}

export async function teardownTenantNet(plan: TenantNetPlan): Promise<void> {
  await sweepIptables(plan.comment);
  await sudoOk(["ip", "link", "del", plan.hostIface]);
  await sudoOk(["ip", "netns", "del", plan.netns]);
}

export async function applyDockerAllowlist(
  containerIp: string,
  allowHosts: string[],
  comment: string,
): Promise<void> {
  await sweepIptables(comment);
  if (allowHosts.length === 0) return;
  const targets = await Promise.all(allowHosts.map(resolveAllowHost));
  await iptables(["-I", "DOCKER-USER", "-s", containerIp, "-m", "comment", "--comment", comment, "-j", "DROP"]);
  await iptables([
    "-I",
    "DOCKER-USER",
    "-s",
    containerIp,
    "-m",
    "conntrack",
    "--ctstate",
    "ESTABLISHED,RELATED",
    "-m",
    "comment",
    "--comment",
    comment,
    "-j",
    "ACCEPT",
  ]);
  for (const target of targets) {
    const destPort = target.port != null ? ["-p", "tcp", "--dport", String(target.port)] : ["-p", "tcp"];
    await iptables([
      "-I",
      "DOCKER-USER",
      "-s",
      containerIp,
      "-d",
      target.ip,
      ...destPort,
      "-m",
      "comment",
      "--comment",
      comment,
      "-j",
      "ACCEPT",
    ]);
  }
}

async function iptables(args: string[]): Promise<void> {
  await sudo(["iptables", ...args]);
}

async function sweepIptables(comment: string): Promise<void> {
  const tables: Array<[string, string]> = [
    ["filter", "INPUT"],
    ["filter", "FORWARD"],
    ["filter", "DOCKER-USER"],
    ["nat", "POSTROUTING"],
  ];
  for (const [table, chain] of tables) {
    for (let i = 0; i < 32; i += 1) {
      let stdout = "";
      try {
        const result = await execFileAsync("sudo", ["-n", "iptables", "-t", table, "-S", chain], {
          timeout: 8_000,
        });
        stdout = result.stdout;
      } catch {
        break;
      }
      const line = stdout.split("\n").find((entry) => commentToken(entry, comment));
      if (!line) break;
      const tokens = line.trim().split(/\s+/);
      if (tokens[0] === "-A") tokens[0] = "-D";
      await sudoOk(["iptables", "-t", table, ...tokens]);
    }
  }
}

function commentToken(line: string, comment: string): boolean {
  return line.includes(`--comment ${comment}`) || line.includes(`--comment "${comment}"`);
}

async function sudo(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("sudo", ["-n", ...args], { timeout: 20_000 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new ComputerError(
      "EGRESS_UNENFORCEABLE",
      `Pack egress cannot be enforced: ${e.stderr?.trim() || e.message || "privileged net setup failed"}`,
    );
  }
}

async function sudoOk(args: string[]): Promise<void> {
  try {
    await execFileAsync("sudo", ["-n", ...args], { timeout: 15_000 });
  } catch {
    // absent rules / devices are fine
  }
}
