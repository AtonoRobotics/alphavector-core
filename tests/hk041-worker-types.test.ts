import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { computerRoot } from "../src/computer/paths.js";
import { SurfaceViolationError } from "../src/errors.js";
import { dryThink, DryStemAdapter } from "../src/habitat/adapter.js";
import {
  CODER_TYPE,
  cognitiveIntentFromUnknown,
  DeepAgentsAdapter,
  isAdmittedWorkerType,
  reapHeldCoders,
  WAKE_KINDS,
  WORKER_TYPE_IDS,
} from "../src/habitat/index.js";
import type { CognitiveAdapter, CognitiveIntent, WorkerTypeId } from "../src/habitat/types.js";
import { AlphaVectorCore } from "../src/kernel.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  signedGenericPack,
} from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";

const CLOSED_V1 = [
  "field_start",
  "field_ask",
  "field_continue",
  "card_decide",
  "worker_done",
  "worker_failed",
  "kill",
  "deadline",
  "connector",
  "routine",
  "mail",
  "architect_message",
] as const;

const V1_TYPES = ["executor", "coder", "retriever", "browser"] as const satisfies readonly WorkerTypeId[];

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

afterEach(() => {
  reapHeldCoders();
});

function talkingLaunch(workerType: string): CognitiveAdapter {
  return {
    name: "hk041-launch",
    owns: ["think"],
    requiresBind: false,
    think(input) {
      if (input.pass === "worker") return dryThink(input);
      return { pass: "talking", act: "launch_worker", workerType };
    },
  };
}

async function habitatCore(adapter: CognitiveAdapter = new DryStemAdapter()) {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk041-"));
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
    core,
    pack: loaded.loaded,
    tenantId: "t1" as const,
    agents,
    record,
    orch: agents.find((a) => a.isOrchestrator)!,
  };
}

describe("HK-041 v1 worker types", () => {
  it("keeps the RE fixture pin at 5091328 and does not rewrite field home or invent brand", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const source = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(source).toMatch(/5091328a2a5d4a9429ec65fef6da5683ede1cac9/);

    const fieldHome = readFileSync(path.join(process.cwd(), "src/surfaces/field.ts"), "utf8");
    expect(fieldHome).toMatch(/home\(tenantId: string, pack\?: LoadedPack\): FieldHome/);
    expect(fieldHome).toMatch(/architectControls: \[\]/);
    expect(fieldHome).not.toMatch(/HK-041|pickAgent|VEYRA|workerType/);
    const changed = changedFilesAgainstMain();
    if (changed) {
      expect(changed).not.toContain("src/surfaces/field.ts");
    }

    const identity = readFileSync(path.join(process.cwd(), "src/identity.ts"), "utf8");
    expect(identity).toMatch(/appDisplay: "AV Dev"/);
    expect(identity).toMatch(/"VEYRA"/);
    expect(identity).not.toMatch(/T0|T1|T2|T3/);

    const typesSrc = readFileSync(path.join(process.cwd(), "src/habitat/types.ts"), "utf8");
    expect(typesSrc).toMatch(/WORKER_TYPE_IDS = \["executor", "coder", "retriever", "browser"\]/);
    expect(typesSrc).toMatch(/export type WorkerTypeId = \(typeof WORKER_TYPE_IDS\)\[number\]/);
    expect(typesSrc).not.toMatch(/T0|T1|T2|T3/);
    expect(typesSrc).not.toMatch(/"analyst"|"researcher"|"planner"/);

    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(/ADAPTER_UNBOUND/);
    expect(kernelSrc).toMatch(/isAdmittedWorkerType/);
    expect(kernelSrc).toMatch(/bookWorker/);
    expect(kernelSrc).not.toMatch(/T0|T1|T2|T3/);
    expect(kernelSrc).not.toMatch(/HK-080|HK-083/);

    expect(WAKE_KINDS).toEqual([...CLOSED_V1]);
    expect(WAKE_KINDS).not.toContain("card_decided");
    expect(WAKE_KINDS).not.toContain("connector_event");
    expect(WAKE_KINDS).not.toContain("worker_type");
    expect(WAKE_KINDS).not.toContain("retriever");
    expect(WAKE_KINDS).not.toContain("browser");
  });

  it("WorkerTypeId is exactly executor, coder, retriever, browser; a fifth type is not admitted", () => {
    expect(WORKER_TYPE_IDS).toEqual([...V1_TYPES]);
    expect(WORKER_TYPE_IDS).toHaveLength(4);
    expect(new Set(WORKER_TYPE_IDS).size).toBe(4);
    for (const id of V1_TYPES) {
      expect(isAdmittedWorkerType(id)).toBe(true);
    }
    expect(isAdmittedWorkerType("analyst")).toBe(false);
    expect(isAdmittedWorkerType("researcher")).toBe(false);
    expect(isAdmittedWorkerType("planner")).toBe(false);
    expect(isAdmittedWorkerType("coder-executor")).toBe(false);
    expect(isAdmittedWorkerType("")).toBe(false);
    expect(CODER_TYPE).toEqual({ id: "coder", executor: true, branch: true });
    expect(CODER_TYPE.id).toBe("coder");
  });

  it("kernel books each of the four types on run.workerType and WorkerRecord.type", async () => {
    for (const type of V1_TYPES) {
      const stack = await habitatCore(talkingLaunch(type));
      const result = await stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      });
      expect(result.launchedWorker).toBe(true);
      expect(result.run?.workerType).toBe(type);
      expect(result.run?.workers).toEqual([result.run?.workerId]);
      const worker = stack.core.habitat.activeWorker(stack.tenantId);
      expect(worker?.type).toBe(type);
      expect(worker?.workerId).toBe(result.run?.workerId);
      expect(worker?.runId).toBe(result.run?.runId);

      const onDisk = JSON.parse(
        readFileSync(computerRoot(stack.computerBaseDir, stack.tenantId).runsFile, "utf8"),
      ) as { runs: Array<{ workerType?: string; workers: string[] }> };
      expect(onDisk.runs[0]?.workerType).toBe(type);
      expect(onDisk.runs[0]?.workers).toEqual([worker?.workerId]);

      const booked = JSON.parse(
        readFileSync(computerRoot(stack.computerBaseDir, stack.tenantId).workersFile, "utf8"),
      ) as { workers: Array<{ type: string; isolation?: string; trailerPath?: string }> };
      expect(booked.workers[0]?.type).toBe(type);

      if (type === "coder") {
        expect(worker?.isolation).toBe("trailer");
        expect(worker?.trailerPath).toBeDefined();
        expect(existsSync(worker!.trailerPath!)).toBe(true);
        expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(true);
        expect(stack.core.habitat.waitForExecutor(stack.tenantId)).toBe(true);
        expect(readFileSync(path.join(worker!.trailerPath!, ".branch"), "utf8")).toContain("coder/");
        expect(booked.workers[0]?.isolation).toBe("trailer");
      } else {
        expect(worker?.isolation).toBeUndefined();
        expect(worker?.trailerPath).toBeUndefined();
        expect(worker?.branch).toBeUndefined();
        expect(worker?.pid).toBeUndefined();
        expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(false);
        expect(stack.core.habitat.isolation(stack.tenantId).exists).toBe(false);
        expect(stack.core.habitat.isolation(stack.tenantId).live).toBe(false);
        expect(booked.workers[0]?.isolation).toBeUndefined();
        expect(booked.workers[0]?.trailerPath).toBeUndefined();
        expect(existsSync(computerRoot(stack.computerBaseDir, stack.tenantId).trailersDir)).toBe(false);
      }
    }
  });

  it("coder still launches on the tenant computer via the existing trailer path", async () => {
    const stack = await habitatCore(talkingLaunch("coder"));
    const result = await stack.core.habitat.wake({
      kind: "field_start",
      tenantId: stack.tenantId,
      pack: stack.pack,
      goal: "one goal",
      recordId: stack.record.id,
    });
    expect(result.run?.workerType).toBe("coder");
    const worker = stack.core.habitat.activeWorker(stack.tenantId);
    expect(worker?.type).toBe("coder");
    expect(worker?.isolation).toBe("trailer");
    expect(worker?.branch).toMatch(/^coder\//);
    expect(worker?.trailerPath).toContain(`${path.sep}trailers${path.sep}`);
    expect(existsSync(path.join(worker!.trailerPath!, "coder-exec.sh"))).toBe(true);
    expect(stack.core.habitat.waitForExecutor(stack.tenantId)).toBe(true);
    expect(CODER_TYPE.executor).toBe(true);
    expect(CODER_TYPE.branch).toBe(true);
  });

  it("field cannot pick workerType or agent; talking inventing a type still fails closed", async () => {
    const stack = await habitatCore();
    await stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { until: "talking" },
    );
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        workerType: "retriever",
      }),
    ).rejects.toMatchObject({ code: "FIELD_CANNOT_PICK_AGENT" });
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        agentId: "agent_picked",
      }),
    ).rejects.toMatchObject({ code: "FIELD_CANNOT_PICK_AGENT" });
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        assigneeAgentId: "agent_picked",
      }),
    ).rejects.toMatchObject({ code: "FIELD_CANNOT_PICK_AGENT" });
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        orchestratorId: "field_orch",
      }),
    ).rejects.toBeInstanceOf(SurfaceViolationError);
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        budget: 1,
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        nextWake: "2026-08-17T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        brief: "field brief",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        steer: "field steer",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        report: "field report",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });

    const invented = await habitatCore(talkingLaunch("analyst"));
    await expect(
      invented.core.habitat.wake({
        kind: "field_start",
        tenantId: invented.tenantId,
        pack: invented.pack,
        goal: "one goal",
        recordId: invented.record.id,
      }),
    ).rejects.toMatchObject({ code: "TALKING_PASS", closed: true });
    expect(invented.core.habitat.getRun(invented.tenantId)?.talkingReject).toEqual({
      code: "TALKING_PASS",
      closed: true,
    });
    expect(invented.core.habitat.activeWorker(invented.tenantId)).toBeUndefined();
    expect(existsSync(computerRoot(invented.computerBaseDir, invented.tenantId).workersFile)).toBe(false);

    const mapped = cognitiveIntentFromUnknown({
      pass: "talking",
      act: "launch_worker",
      workerType: "analyst",
    });
    expect(mapped.workerType).toBe("analyst");
    expect(isAdmittedWorkerType(mapped.workerType)).toBe(false);
  });

  it("unbound adapter stays ADAPTER_UNBOUND; DryStem is fixture-only", async () => {
    const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk041-unbound-"));
    const { anchors, binding } = await signedGenericPack();
    const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir);
    const loaded = core.packs.load({ tenantId: "t1", binding, actor: "architect" });
    if (!loaded.ok) throw new Error(loaded.message);
    core.agents.instantiateFromPack(loaded.loaded, "architect");
    const record = core.records.put("t1", { type: "case", label: "Subject" });
    expect(core.habitat.cognitiveAdapterName()).toBe(new DeepAgentsAdapter().name);
    expect(core.habitat.cognitiveAdapterName()).not.toBe(new DryStemAdapter().name);
    await expect(
      core.habitat.wake({
        kind: "field_start",
        tenantId: "t1",
        pack: loaded.loaded,
        goal: "one goal",
        recordId: record.id,
      }),
    ).rejects.toMatchObject({ code: "ADAPTER_UNBOUND", closed: true });
    expect(core.habitat.getRun("t1")).toBeUndefined();
    expect(existsSync(computerRoot(computerBaseDir, "t1").workersFile)).toBe(false);
  });
});
