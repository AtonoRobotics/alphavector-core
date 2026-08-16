import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerHost } from "../src/computer/host.js";
import { extractRootfs, stampImage } from "../src/computer/image.js";
import { computerRoot } from "../src/computer/paths.js";
import { DryStemAdapter, isPidAlive, reapHeldCoders } from "../src/habitat/index.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { PRODUCT } from "../src/identity.js";
import { AlphaVectorCore } from "../src/kernel.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  bootTestFieldCore,
  signedGenericPack,
} from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const hosts: ComputerHost[] = [];
const servers: FieldHttpServer[] = [];

afterEach(async () => {
  reapHeldCoders();
  while (servers.length) {
    await servers.pop()?.close();
  }
  for (const host of hosts) {
    try {
      await host.stop("t1");
    } catch {
      // ignore
    }
    try {
      await host.stop("tenant-a");
    } catch {
      // ignore
    }
  }
  hosts.length = 0;
});

async function habitatWithComputer(tenantId = "t1") {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk075-"));
  const { anchors, binding } = await signedGenericPack();
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir, {
    adapter: new DryStemAdapter(),
  });
  const loaded = core.packs.load({ tenantId, binding, actor: "architect" });
  if (!loaded.ok) throw new Error(loaded.message);
  core.agents.instantiateFromPack(loaded.loaded, "architect");
  const record = core.records.put(tenantId, { type: "case", label: "Subject" });
  return { computerBaseDir, core, pack: loaded.loaded, tenantId, record };
}

function cmdlineOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

function exeOf(pid: number): string {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return "";
  }
}

describe("HK-075 workers on the tenant computer", () => {
  it("keeps the RE fixture pin at 5091328", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    expect(readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8")).toContain(
      "5091328a2a5d4a9429ec65fef6da5683ede1cac9",
    );
    expect(PRODUCT.appDisplay).toBe("AV Dev");
    expect(PRODUCT.appDisplay).not.toMatch(/VEYRA/);
  });

  it("a worker does real work on the tenant computer, not in-process and not as a host kernel child", async () => {
    const { core, pack, tenantId, record, computerBaseDir } = await habitatWithComputer();
    const working = await core.habitat.wake(
      {
        kind: "field_start",
        tenantId,
        pack,
        goal: "one goal",
        recordId: record.id,
      },
      { holdWorker: true },
    );
    expect(working.launchedWorker).toBe(true);
    const host = await core.habitat.ensureComputer(tenantId);
    hosts.push(host);

    const worker = core.habitat.activeWorker(tenantId);
    expect(worker).toBeDefined();
    expect(worker!.pid).toBeDefined();
    expect(isPidAlive(worker!.pid)).toBe(true);

    const paths = computerRoot(computerBaseDir, tenantId);
    expect(worker!.trailerPath.startsWith(paths.disk + path.sep)).toBe(true);
    expect(worker!.trailerPath).toContain(`${path.sep}trailers${path.sep}`);
    expect(existsSync(path.join(paths.disk, "workers.json"))).toBe(false);
    expect(existsSync(paths.workersFile)).toBe(true);

    expect(core.habitat.waitForExecutor(tenantId, 8000)).toBe(true);
    const output = await host.readFile(tenantId, `trailers/${worker!.workerId}/executor-output.txt`);
    expect(output.exists).toBe(true);
    expect(output.content?.trim()).toBe("coder-executor");

    const inside = await host.execInMachine({
      tenantId,
      agentId: worker!.agent.agentId,
      argv: ["cat", `/home/trailers/${worker!.workerId}/executor-output.txt`],
      cwd: `/home/trailers/${worker!.workerId}`,
    });
    expect(inside.exitCode, inside.stderr).toBe(0);
    expect(inside.stdout.trim()).toBe("coder-executor");

    const osRelease = await host.execInMachine({
      tenantId,
      agentId: worker!.agent.agentId,
      argv: ["cat", "/etc/os-release"],
    });
    expect(osRelease.exitCode, osRelease.stderr).toBe(0);
    expect(osRelease.stdout.toLowerCase()).toContain("alpine");

    const cmd = cmdlineOf(worker!.pid!);
    expect(cmd).not.toContain(process.execPath);
    expect(cmd).not.toMatch(/\bnode\b/);
    const exe = exeOf(worker!.pid!);
    expect(exe).not.toBe(process.execPath);
    expect(exe).not.toMatch(/\/node$/);

    const workerSrc = readFileSync(path.join(REPO_ROOT, "src/habitat/worker.ts"), "utf8");
    expect(workerSrc).not.toMatch(/spawn\(\s*process\.execPath\s*,/);
    expect(workerSrc).not.toMatch(/spawnSync\(\s*process\.execPath\s*,/);
    expect(workerSrc).toMatch(/execInMachine/);
    expect(workerSrc).toMatch(/spawnHeld/);
    expect(workerSrc).toMatch(/\/home\/trailers\//);
    expect(workerSrc).not.toMatch(/colorForDisplay/);
    expect(workerSrc).not.toMatch(/VEYRA/);
    expect(workerSrc).not.toMatch(/\bT0\b|\bT1\b|\bT2\b|\bT3\b/);
  });

  it("an update keeps disk files and browser logins; reset-from-snapshot stays last resort", async () => {
    const { core, pack, tenantId, record } = await habitatWithComputer();
    await core.habitat.wake({
      kind: "field_start",
      tenantId,
      pack,
      goal: "one goal",
      recordId: record.id,
    });
    const host = await core.habitat.ensureComputer(tenantId);
    hosts.push(host);
    const worker = core.habitat.activeWorker(tenantId)!;
    expect(core.habitat.waitForExecutor(tenantId, 8000)).toBe(true);

    await host.execInMachine({
      tenantId,
      agentId: worker.agent.agentId,
      argv: [
        "sh",
        "-c",
        "echo keep-me > /home/keep.txt && mkdir -p /home/.config/browser && echo cookie > /home/.config/browser/login",
      ],
    });

    const tmp = await mkdtemp(path.join(os.tmpdir(), "av-hk075-img-"));
    const tarball = path.join(REPO_ROOT, "images", "alpine-minirootfs-3.20.3-x86_64.tar.gz");
    const newRoot = path.join(tmp, "rootfs");
    await extractRootfs(tarball, newRoot);
    await stampImage(newRoot, "alpine-3.20.3-av-computer-rebuilt");
    await writeFile(path.join(newRoot, "etc", "av-rebuild"), "yes\n");

    const before = await host.driver.status(tenantId);
    const updated = await host.updateImage(tenantId, {
      imageId: "alpine-3.20.3-av-computer-rebuilt",
      source: newRoot,
    });
    expect(updated.imageId).toBe("alpine-3.20.3-av-computer-rebuilt");
    expect(updated.imageId).not.toBe(before?.imageId);

    const kept = await host.readFile(tenantId, "keep.txt");
    expect(kept.exists).toBe(true);
    expect(kept.content?.trim()).toBe("keep-me");
    const login = await host.readFile(tenantId, ".config/browser/login");
    expect(login.exists).toBe(true);
    expect(login.content?.trim()).toBe("cookie");
    const trailerOut = await host.readFile(tenantId, `trailers/${worker.workerId}/executor-output.txt`);
    expect(trailerOut.exists).toBe(true);
    expect(trailerOut.content?.trim()).toBe("coder-executor");

    const hostSrc = readFileSync(path.join(REPO_ROOT, "src/computer/host.ts"), "utf8");
    const workerSrc = readFileSync(path.join(REPO_ROOT, "src/habitat/worker.ts"), "utf8");
    expect(workerSrc).not.toMatch(/resetFromSnapshot/);
    expect(hostSrc).toMatch(/updateImage/);
    const dockerSrc = readFileSync(path.join(REPO_ROOT, "src/computer/docker-driver.ts"), "utf8");
    expect(dockerSrc).toMatch(/RESET_LAST_RESORT/);
  });

  it("two agents share the disk and have separate desktops by display / vncPort / viewerPath / agentId", async () => {
    const { core, tenantId } = await habitatWithComputer();
    const host = await core.habitat.ensureComputer(tenantId);
    hosts.push(host);

    const write = await host.execInMachine({
      tenantId,
      agentId: "researcher",
      argv: ["sh", "-c", "echo shared-secret > /home/shared.txt"],
    });
    expect(write.exitCode).toBe(0);
    const read = await host.execInMachine({
      tenantId,
      agentId: "writer",
      argv: ["cat", "/home/shared.txt"],
    });
    expect(read.stdout.trim()).toBe("shared-secret");

    const deskA = await host.ensureDesktop(tenantId, "researcher");
    const deskB = await host.ensureDesktop(tenantId, "writer");
    expect(deskA.agentId).toBe("researcher");
    expect(deskB.agentId).toBe("writer");
    expect(deskA.display).not.toBe(deskB.display);
    expect(deskA.desktopPath).not.toBe(deskB.desktopPath);
    expect(deskA.viewerPath).not.toBe(deskB.viewerPath);
    expect(deskA.vncPort).not.toBe(deskB.vncPort);

    const viewerA = await readFile(deskA.viewerPath, "utf8");
    const viewerB = await readFile(deskB.viewerPath, "utf8");
    expect(viewerA).toContain("researcher");
    expect(viewerB).toContain("writer");
    expect(viewerA).not.toContain("writer");
    expect(viewerB).not.toContain("researcher");
    expect(viewerA).toContain(`display :${deskA.display}`);
    expect(viewerB).toContain(`display :${deskB.display}`);
    expect(viewerA).toContain(`localhost:${deskA.vncPort}`);
    expect(viewerB).toContain(`localhost:${deskB.vncPort}`);
    expect(viewerA).toContain("AV Dev");
    expect(viewerA).toContain("Alpha Vector LLC");
    expect(viewerA).not.toMatch(/VEYRA|colorForDisplay|#C4A574/);
    expect(viewerB).not.toMatch(/VEYRA|colorForDisplay|#C4A574/);

    const desktopSrc = readFileSync(path.join(REPO_ROOT, "src/computer/desktop.ts"), "utf8");
    expect(desktopSrc).not.toMatch(/colorForDisplay/);
  });

  it("field still cannot configure the machine / models / prompts / Temporal / tools", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hk075-field-"));
    const { core, pack, tenantId } = await bootTestFieldCore("t1", {
      computerBaseDir: dir,
      adapter: new DryStemAdapter(),
    });
    if (core.computer) hosts.push(core.computer);
    const architect = core.fieldTokens.issue({ tenantId, principal: "architect" });
    const field = core.fieldTokens.issue({
      tenantId,
      principal: "field",
      presented: architect.token,
    });
    const server = new FieldHttpServer({ core, pack, tenantId });
    servers.push(server);
    const { url } = await server.listen(0, "127.0.0.1");
    const headers = { authorization: `Bearer ${field.token}` };

    for (const route of [
      "/field/models",
      "/field/prompts",
      "/field/temporal",
      "/field/tools",
      "/field/machine",
      "/field/hypervisor",
      "/field/images",
      "/field/computer",
      "/field/desktop",
      "/field/networking",
    ]) {
      const res = await fetch(`${url}${route}`, { headers });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("SURFACE_VIOLATION");
      expect(body.message).toMatch(/cannot configure models, prompts, Temporal, tools, trust anchors, or the machine/);
    }

    const serverSrc = readFileSync(path.join(REPO_ROOT, "src/http/field-server.ts"), "utf8");
    expect(serverSrc).toMatch(/machine|hypervisor|images\?|computer/);
    expect(serverSrc).toMatch(/or the machine/);
  });
});
