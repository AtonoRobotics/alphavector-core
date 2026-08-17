import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/agents/types.js";
import type { ComputerHost } from "../src/computer/host.js";
import { computerRoot } from "../src/computer/paths.js";
import type { DesktopSession } from "../src/computer/types.js";
import { SurfaceViolationError } from "../src/errors.js";
import { dryThink, DryStemAdapter } from "../src/habitat/adapter.js";
import {
  isPidAlive,
  KERNEL_TRAILER_TTL_MS,
  reapHeldCoders,
  WAKE_KINDS,
} from "../src/habitat/index.js";
import type { CognitiveAdapter, WorkerTypeId } from "../src/habitat/types.js";
import { FieldClient } from "../src/http/field-client.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { AlphaVectorCore } from "../src/kernel.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  bootTestFieldCore,
  REPO_ROOT,
  signedGenericPack,
} from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";

const computers: Array<{ host: ComputerHost; tenantId: string }> = [];
const servers: FieldHttpServer[] = [];

/** Files this PR changes vs origin/main. Skip when that ref is not in the checkout. */
function changedFilesAgainstMain(): string[] | undefined {
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });
  } catch {
    return undefined;
  }
  try {
    const out = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

afterEach(async () => {
  reapHeldCoders();
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const { host, tenantId } of computers.splice(0)) {
    try {
      await host.stop(tenantId);
    } catch {
      // already gone
    }
  }
});

function talkingLaunch(workerType: WorkerTypeId): CognitiveAdapter {
  return {
    name: "hk044-launch",
    owns: ["think"],
    requiresBind: false,
    think(input) {
      if (input.pass === "worker") return dryThink(input);
      return { pass: "talking", act: "launch_worker", workerType };
    },
  };
}

async function habitatCore(adapter: CognitiveAdapter = new DryStemAdapter()) {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk044-"));
  const { anchors, binding } = await signedGenericPack();
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir, {
    adapter,
  });
  const loaded = core.packs.load({ tenantId: "t1", binding, actor: "architect" });
  if (!loaded.ok) throw new Error(loaded.message);
  const agents = core.agents.instantiateFromPack(loaded.loaded, "architect");
  const record = core.records.put("t1", { type: "case", label: "Subject" });
  return {
    computerBaseDir,
    anchors,
    binding,
    core,
    pack: loaded.loaded,
    tenantId: "t1" as const,
    agents,
    record,
    orch: agents.find((a) => a.isOrchestrator)!,
  };
}

async function startCoder(stack: Awaited<ReturnType<typeof habitatCore>>) {
  const result = await stack.core.habitat.wake(
    {
      kind: "field_start",
      tenantId: stack.tenantId,
      pack: stack.pack,
      goal: "one goal",
      recordId: stack.record.id,
    },
    { holdWorker: true },
  );
  const worker = stack.core.habitat.activeWorker(stack.tenantId);
  if (!worker?.trailerPath) throw new Error("expected a coder trailer");
  return { result, worker, trailerPath: worker.trailerPath };
}

async function persistDesk(
  stack: { core: AlphaVectorCore; tenantId: string; orch: AgentRecord },
): Promise<{ host: ComputerHost; desk: DesktopSession; session: string }> {
  const host = await stack.core.habitat.ensureComputer(stack.tenantId);
  computers.push({ host, tenantId: stack.tenantId });
  const desk = await host.ensureDesktop(stack.tenantId, stack.orch.agentId);
  const session = path.join(desk.desktopPath, "session.json");
  expect(existsSync(session)).toBe(true);
  expect(existsSync(path.join(desk.desktopPath, "display"))).toBe(true);
  return { host, desk, session };
}

function expectDeskAlive(desk: DesktopSession, session: string): void {
  expect(existsSync(session)).toBe(true);
  expect(existsSync(path.join(desk.desktopPath, "display"))).toBe(true);
  expect(existsSync(`/tmp/.X11-unix/X${desk.display}`)).toBe(true);
  const persisted = JSON.parse(readFileSync(session, "utf8")) as { agentId?: string; display?: number };
  expect(persisted.agentId).toBe(desk.agentId);
  expect(persisted.display).toBe(desk.display);
}

function readDiskWorker(computerBaseDir: string, tenantId: string) {
  const file = computerRoot(computerBaseDir, tenantId).workersFile;
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as {
    workers: Array<{
      type?: string;
      expiresAt?: string;
      isolation?: string;
      trailerPath?: string;
    }>;
  };
}

describe("HK-044 trailer TTL / sticky desk", () => {
  it("keeps the RE fixture pin at 5091328 and does not rewrite field home", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const source = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(source).toMatch(/5091328a2a5d4a9429ec65fef6da5683ede1cac9/);

    const fieldHome = readFileSync(path.join(process.cwd(), "src/surfaces/field.ts"), "utf8");
    expect(fieldHome).toMatch(/home\(tenantId: string, pack\?: LoadedPack\): FieldHome/);
    expect(fieldHome).toMatch(/architectControls: \[\]/);
    expect(fieldHome).not.toMatch(/trailerTtl|KERNEL_TRAILER_TTL|expiresAt|HK-044/);
    const changed = changedFilesAgainstMain();
    if (changed) {
      expect(changed).not.toContain("src/surfaces/field.ts");
    }

    expect(KERNEL_TRAILER_TTL_MS).toBe(4 * 60 * 60 * 1000);
    expect(WAKE_KINDS).not.toContain("trailer_ttl");
    expect(WAKE_KINDS).not.toContain("ttl");
  });

  it("worker_done still tears the trailer and the desk still exists", async () => {
    const stack = await habitatCore();
    const { worker, trailerPath } = await startCoder(stack);
    const { host, desk, session } = await persistDesk(stack);
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(true);
    expect(existsSync(trailerPath)).toBe(true);

    const done = await stack.core.habitat.wake({
      kind: "worker_done",
      tenantId: stack.tenantId,
      pack: stack.pack,
    });
    expect(done.run?.status).toBe("completed");
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(false);
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();
    expect(existsSync(trailerPath)).toBe(false);
    expect(isPidAlive(worker.pid)).toBe(false);
    expectDeskAlive(desk, session);
    const again = await host.ensureDesktop(stack.tenantId, stack.orch.agentId);
    expect(again.display).toBe(desk.display);
    expect(again.desktopPath).toBe(desk.desktopPath);
  });

  it("kill still tears the trailer and the desk still exists", async () => {
    const stack = await habitatCore();
    const { worker, trailerPath } = await startCoder(stack);
    const { host, desk, session } = await persistDesk(stack);
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(true);

    const killed = await stack.core.habitat.wake({
      kind: "kill",
      tenantId: stack.tenantId,
      reason: "stop",
    });
    expect(killed.run?.status).toBe("killed");
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(false);
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();
    expect(existsSync(trailerPath)).toBe(false);
    expect(isPidAlive(worker.pid)).toBe(false);
    expectDeskAlive(desk, session);
    const again = await host.ensureDesktop(stack.tenantId, stack.orch.agentId);
    expect(again.display).toBe(desk.display);
    expect(again.desktopPath).toBe(desk.desktopPath);
  });

  it("advanceClock past TTL tears the trailer; desk still exists; leftover trailer directory is gone", async () => {
    const stack = await habitatCore();
    const { worker, trailerPath } = await startCoder(stack);
    const { host, desk, session } = await persistDesk(stack);
    expect(worker.type).toBe("coder");
    expect(worker.expiresAt).toBeDefined();
    expect(Number.isFinite(Date.parse(worker.expiresAt!))).toBe(true);
    expect(Date.parse(worker.expiresAt!)).toBeGreaterThan(Date.parse(worker.createdAt));

    const onDisk = readDiskWorker(stack.computerBaseDir, stack.tenantId);
    expect(onDisk?.workers[0]?.expiresAt).toBe(worker.expiresAt);
    expect(onDisk?.workers[0]?.isolation).toBe("trailer");
    expect(existsSync(trailerPath)).toBe(true);
    const statusBefore = stack.core.habitat.getRun(stack.tenantId)?.status;
    expect(statusBefore).not.toBe("completed");
    expect(statusBefore).not.toBe("killed");

    const replay = new AlphaVectorCore(
      stack.anchors,
      path.join(stack.computerBaseDir, "state"),
      stack.computerBaseDir,
      { adapter: new DryStemAdapter() },
    );
    const loaded = replay.packs.load({ tenantId: stack.tenantId, binding: stack.binding, actor: "architect" });
    if (!loaded.ok) throw new Error(loaded.message);
    replay.agents.instantiateFromPack(loaded.loaded, "architect");
    replay.habitat.setPack(stack.tenantId, loaded.loaded);

    await replay.habitat.advanceClock(worker.expiresAt!);

    expect(existsSync(trailerPath)).toBe(false);
    expect(replay.habitat.trailerExists(stack.tenantId)).toBe(false);
    expect(replay.habitat.activeWorker(stack.tenantId)).toBeUndefined();
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(false);
    expect(readDiskWorker(stack.computerBaseDir, stack.tenantId)?.workers ?? []).toEqual([]);
    const after = replay.habitat.getRun(stack.tenantId);
    expect(after?.status).toBe(statusBefore);
    expect(after?.status).not.toBe("completed");
    expect(after?.status).not.toBe("killed");
    expect(after?.workers).toEqual([]);
    expectDeskAlive(desk, session);
    const again = await host.ensureDesktop(stack.tenantId, stack.orch.agentId);
    expect(again.display).toBe(desk.display);

    const typed = await habitatCore(talkingLaunch("executor"));
    await typed.core.habitat.wake({
      kind: "field_start",
      tenantId: typed.tenantId,
      pack: typed.pack,
      goal: "one goal",
      recordId: typed.record.id,
    });
    const booked = typed.core.habitat.activeWorker(typed.tenantId);
    expect(booked?.type).toBe("executor");
    expect(booked?.expiresAt).toBeUndefined();
    expect(booked?.isolation).toBeUndefined();
    expect(typed.core.habitat.trailerExists(typed.tenantId)).toBe(false);
    expect(existsSync(computerRoot(typed.computerBaseDir, typed.tenantId).trailersDir)).toBe(false);
    await typed.core.habitat.advanceClock("2099-01-01T00:00:00.000Z");
    expect(typed.core.habitat.activeWorker(typed.tenantId)?.workerId).toBe(booked?.workerId);
    expect(typed.core.habitat.trailerExists(typed.tenantId)).toBe(false);
    expect(existsSync(computerRoot(typed.computerBaseDir, typed.tenantId).trailersDir)).toBe(false);
    expect(typed.core.habitat.getRun(typed.tenantId)?.status).not.toBe("killed");
  });

  it("field cannot set or extend trailer TTL", async () => {
    const stack = await habitatCore();
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        trailerTtl: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(SurfaceViolationError);
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        trailerTtl: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    expect(stack.core.habitat.getRun(stack.tenantId)).toBeUndefined();
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();

    await expect(
      stack.core.habitat.observeFieldStart({
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        trailerTtl: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });

    const { worker } = await startCoder(stack);
    const stamped = worker.expiresAt;
    expect(stamped).toBeTruthy();

    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        trailerTtl: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        expiresAt: "2099-01-01T00:00:00.000Z",
      } as Parameters<typeof stack.core.habitat.wake>[0]),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    expect(stack.core.habitat.activeWorker(stack.tenantId)?.expiresAt).toBe(stamped);
    expect(readDiskWorker(stack.computerBaseDir, stack.tenantId)?.workers[0]?.expiresAt).toBe(stamped);

    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hk044-http-"));
    const { core, pack } = await bootTestFieldCore("t1", {
      computerBaseDir: dir,
      adapter: new DryStemAdapter(),
    });
    const architect = core.fieldTokens.issue({ tenantId: "t1", principal: "architect" });
    const fieldToken = core.fieldTokens.issue({
      tenantId: "t1",
      principal: "field",
      presented: architect.token,
    }).token;
    const server = new FieldHttpServer({ core, pack, tenantId: "t1" });
    servers.push(server);
    const { url } = await server.listen(0, "127.0.0.1");
    const field = new FieldClient(url, fieldToken);
    const home = await field.home();
    const kind = home.journeyKinds[0]?.id ?? "buyer";
    const type = home.recordKinds[0]?.id ?? "record";
    const record = await field.createApprovedRecord(type, "Subject");
    await field.openApproved(kind, record.id);

    const blockedStart = await fetch(`${url}/field/journeys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        journeyKind: kind,
        objective: "http goal",
        recordId: record.id,
        trailerTtl: "2099-01-01T00:00:00.000Z",
      }),
    });
    expect(blockedStart.status).toBe(403);
    expect(((await blockedStart.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    expect(core.habitat.getRun("t1")).toBeUndefined();

    await field.start(kind, "http goal", record.id);
    const httpExpiry = core.habitat.activeWorker("t1")?.expiresAt;
    expect(httpExpiry).toBeTruthy();

    const blockedContinue = await fetch(`${url}/field/continue`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expiresAt: "2099-01-01T00:00:00.000Z" }),
    });
    expect(blockedContinue.status).toBe(403);
    expect(((await blockedContinue.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    expect(core.habitat.activeWorker("t1")?.expiresAt).toBe(httpExpiry);

    const blockedKill = await fetch(`${url}/field/kill`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "stop", trailerTtl: "2099-01-01T00:00:00.000Z" }),
    });
    expect(blockedKill.status).toBe(403);
    expect(((await blockedKill.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    expect(core.habitat.activeWorker("t1")?.expiresAt).toBe(httpExpiry);
    expect(core.habitat.getRun("t1")?.status).not.toBe("killed");
  });
});
