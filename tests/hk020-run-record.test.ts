import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { computerRoot } from "../src/computer/paths.js";
import { SurfaceViolationError } from "../src/errors.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import {
  KERNEL_RUN_BUDGET,
  reapHeldCoders,
  WAKE_KINDS,
} from "../src/habitat/index.js";
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
});

async function habitatCore() {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk020-"));
  const { anchors, binding } = await signedGenericPack();
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir, {
    adapter: new DryStemAdapter(),
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

function readDiskRun(computerBaseDir: string, tenantId: string) {
  const file = computerRoot(computerBaseDir, tenantId).runsFile;
  const store = JSON.parse(readFileSync(file, "utf8")) as {
    runs: Array<{
      runId: string;
      tenantId: string;
      goal: string;
      status: string;
      orchestratorId: string;
      workers: string[];
      nextWake: string;
      budget: number;
      pendingCardId?: string;
      workerId?: string;
    }>;
  };
  return { file, run: store.runs[0] };
}

describe("HK-020 durable run control record", () => {
  it("keeps the RE fixture pin at 5091328 and does not rewrite field home or invent brand", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const source = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(source).toMatch(/5091328a2a5d4a9429ec65fef6da5683ede1cac9/);

    const fieldHome = readFileSync(path.join(process.cwd(), "src/surfaces/field.ts"), "utf8");
    expect(fieldHome).toMatch(/home\(tenantId: string, pack\?: LoadedPack\): FieldHome/);
    expect(fieldHome).toMatch(/architectControls: \[\]/);
    expect(fieldHome).not.toMatch(/orchestratorId|nextWake|HK-020|KERNEL_RUN_BUDGET/);
    const changed = changedFilesAgainstMain();
    if (changed) {
      expect(changed).not.toContain("src/surfaces/field.ts");
    }

    const identity = readFileSync(path.join(process.cwd(), "src/identity.ts"), "utf8");
    expect(identity).toMatch(/appDisplay: "Pyrallon"/);
    expect(identity).toMatch(/"VEYRA"/);
    expect(identity).not.toMatch(/T0|T1|T2|T3/);

    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(/ADAPTER_UNBOUND/);
    expect(kernelSrc).not.toMatch(/nextWakeTicker|nextWakeFire/);
    expect(kernelSrc).not.toMatch(/bind\.nextWake/);
    expect(kernelSrc).toMatch(/event\.nextWake !== undefined/);
    expect(kernelSrc).toMatch(/intent\.nextWake/);

    expect(WAKE_KINDS).not.toContain("card_decided");
    expect(WAKE_KINDS).not.toContain("connector_event");
    expect(KERNEL_RUN_BUDGET).toBe(0);
  });

  it("RunRecord on disk after field_start has goal, orchestratorId, status, workers, pendingCardId, nextWake, budget", async () => {
    const stack = await habitatCore();
    const started = await stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { until: "talking" },
    );
    const run = started.run!;
    expect(run.goal).toBe("one goal");
    expect(run.orchestratorId).toBe(stack.orch.agentId);
    expect(run.status).toBe("talking");
    expect(run.workers).toEqual([]);
    expect(run.pendingCardId).toBeUndefined();
    expect(run.nextWake).toBe("");
    expect(run.budget).toBe(KERNEL_RUN_BUDGET);

    const onDisk = readDiskRun(stack.computerBaseDir, stack.tenantId);
    expect(existsSync(onDisk.file)).toBe(true);
    expect(onDisk.run?.runId).toBe(run.runId);
    expect(onDisk.run?.goal).toBe("one goal");
    expect(onDisk.run?.orchestratorId).toBe(stack.orch.agentId);
    expect(onDisk.run?.status).toBe("talking");
    expect(onDisk.run?.workers).toEqual([]);
    expect(onDisk.run?.pendingCardId).toBeUndefined();
    expect(onDisk.run?.nextWake).toBe("");
    expect(onDisk.run?.budget).toBe(0);
  });

  it("orchestratorId is the loaded orchestrator, not a field-supplied id", async () => {
    const stack = await habitatCore();
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        orchestratorId: "field_supplied_orch",
      }),
    ).rejects.toBeInstanceOf(SurfaceViolationError);
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        orchestratorId: "field_supplied_orch",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    expect(stack.core.habitat.getRun(stack.tenantId)).toBeUndefined();
    expect(existsSync(computerRoot(stack.computerBaseDir, stack.tenantId).runsFile)).toBe(false);

    const started = await stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { until: "talking" },
    );
    expect(started.run?.orchestratorId).toBe(stack.orch.agentId);
    expect(started.run?.orchestratorId).not.toBe("field_supplied_orch");
    expect(readDiskRun(stack.computerBaseDir, stack.tenantId).run?.orchestratorId).toBe(stack.orch.agentId);
  });

  it("workers is the booked set (0 before launch, 1 after a held coder)", async () => {
    const stack = await habitatCore();
    const talking = await stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { until: "talking" },
    );
    expect(talking.run?.workers).toEqual([]);
    expect(talking.run?.workerId).toBeUndefined();
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();
    expect(readDiskRun(stack.computerBaseDir, stack.tenantId).run?.workers).toEqual([]);

    const held = await stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { holdWorker: true },
    );
    const workerId = held.run?.workerId;
    expect(workerId).toMatch(/^worker_/);
    expect(held.run?.workers).toEqual([workerId]);
    expect(stack.core.habitat.activeWorker(stack.tenantId)?.workerId).toBe(workerId);
    expect(readDiskRun(stack.computerBaseDir, stack.tenantId).run?.workers).toEqual([workerId]);
  });

  it("restart of core objects on the same computerBaseDir still shows the same run fields", async () => {
    const first = await habitatCore();
    const started = await first.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: first.tenantId,
        pack: first.pack,
        goal: "one goal",
        recordId: first.record.id,
      },
      { holdWorker: true },
    );
    const run = started.run!;
    expect(run.orchestratorId).toBe(first.orch.agentId);
    expect(run.workers).toEqual([run.workerId]);
    expect(run.nextWake).toBe("");
    expect(run.budget).toBe(KERNEL_RUN_BUDGET);

    const second = new AlphaVectorCore(
      first.anchors,
      path.join(first.computerBaseDir, "state"),
      first.computerBaseDir,
    );
    const again = second.habitat.getRun(first.tenantId);
    expect(again?.runId).toBe(run.runId);
    expect(again?.goal).toBe("one goal");
    expect(again?.orchestratorId).toBe(first.orch.agentId);
    expect(again?.status).toBe(run.status);
    expect(again?.workers).toEqual([run.workerId]);
    expect(again?.pendingCardId).toBe(run.pendingCardId);
    expect(again?.nextWake).toBe("");
    expect(again?.budget).toBe(0);
    expect(again?.workerId).toBe(run.workerId);
  });

  it("field cannot set orchestratorId or budget (SURFACE_VIOLATION or ignored)", async () => {
    const stack = await habitatCore();
    await expect(
      stack.core.habitat.observeFieldStart({
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        orchestratorId: "field_orch",
        budget: 3,
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });

    const started = await stack.core.habitat.wake(
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
        kind: "field_ask",
        tenantId: stack.tenantId,
        pack: stack.pack,
        orchestratorId: "field_orch",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        budget: 0,
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });

    const after = stack.core.habitat.getRun(stack.tenantId);
    expect(after?.runId).toBe(started.run?.runId);
    expect(after?.orchestratorId).toBe(stack.orch.agentId);
    expect(after?.budget).toBe(KERNEL_RUN_BUDGET);

    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hk020-http-"));
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
    const orch = core.agents.list("t1").find((a) => a.isOrchestrator)!;
    const res = await fetch(`${url}/field/journeys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        journeyKind: kind,
        objective: "http goal",
        recordId: record.id,
        orchestratorId: "field_supplied_orch",
        budget: 99,
      }),
    });
    expect(res.status).toBe(201);
    const run = core.habitat.getRun("t1");
    expect(run?.goal).toBe("http goal");
    expect(run?.orchestratorId).toBe(orch.agentId);
    expect(run?.orchestratorId).not.toBe("field_supplied_orch");
    expect(run?.budget).toBe(KERNEL_RUN_BUDGET);
    expect(run?.budget).not.toBe(99);
  });

  it("keeps nextWake on the run record; HK-024 owns set and fire", () => {
    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    const adapterSrc = readFileSync(path.join(process.cwd(), "src/habitat/adapter.ts"), "utf8");
    const typesSrc = readFileSync(path.join(process.cwd(), "src/habitat/types.ts"), "utf8");
    expect(kernelSrc).toMatch(/nextWake: typeof run\.nextWake === "string" \? run\.nextWake : ""/);
    expect(kernelSrc).toMatch(/fireDueNextWake\(/);
    expect(kernelSrc).not.toMatch(/setInterval\([^)]*nextWake|nextWake[^;]*setInterval/);
    expect(adapterSrc).not.toMatch(/nextWake/);
    expect(typesSrc).toMatch(/Empty means nothing to fire/);
    expect(WAKE_KINDS).toEqual([
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
    ]);
  });
});
