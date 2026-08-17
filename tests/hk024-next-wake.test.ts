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
  DeepAgentsAdapter,
  hashWakePayload,
  reapHeldCoders,
  WAKE_KINDS,
} from "../src/habitat/index.js";
import type { AdapterPass, CognitiveAdapter, CognitiveIntent, WakeKind } from "../src/habitat/types.js";
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

async function waitUntil(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for in-flight pass");
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

function scheduleOnStart(due: string): CognitiveAdapter {
  return {
    name: "hk024-schedule",
    owns: ["think"],
    requiresBind: false,
    think(input) {
      const intent = dryThink(input);
      if (input.pass === "talking" && input.event.kind === "field_start") {
        return { ...intent, nextWake: due };
      }
      return intent;
    },
  };
}

function invalidNextWakeAdapter(value: unknown): CognitiveAdapter {
  return {
    name: "hk024-invalid",
    owns: ["think"],
    requiresBind: false,
    think(input) {
      const intent = dryThink(input) as CognitiveIntent & { nextWake?: unknown };
      if (input.pass === "talking") {
        intent.nextWake = value;
      }
      return intent as CognitiveIntent;
    },
  };
}

function gatedThink(holdKind: WakeKind, holdPass: AdapterPass) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  let entered = false;
  const adapter: CognitiveAdapter = {
    name: "hk024-gate",
    owns: ["think"],
    requiresBind: false,
    async think(input) {
      const mark = `${input.event.kind}:${input.pass}`;
      order.push(mark);
      if (input.event.kind === holdKind && input.pass === holdPass) {
        entered = true;
        await held;
      }
      return dryThink(input);
    },
  };
  return {
    adapter,
    release: () => release(),
    order,
    entered: () => entered,
  };
}

function gatedAfterSchedule(due: string, holdKind: WakeKind, holdPass: AdapterPass) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  let entered = false;
  const adapter: CognitiveAdapter = {
    name: "hk024-gate-schedule",
    owns: ["think"],
    requiresBind: false,
    async think(input) {
      const mark = `${input.event.kind}:${input.pass}`;
      order.push(mark);
      if (input.event.kind === holdKind && input.pass === holdPass) {
        entered = true;
        await held;
      }
      const intent = dryThink(input);
      if (input.pass === "talking" && input.event.kind === "field_start") {
        return { ...intent, nextWake: due };
      }
      return intent;
    },
  };
  return {
    adapter,
    release: () => release(),
    order,
    entered: () => entered,
  };
}

async function habitatCore(adapter: CognitiveAdapter = new DryStemAdapter()) {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk024-"));
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

function readDiskRun(computerBaseDir: string, tenantId: string) {
  const file = computerRoot(computerBaseDir, tenantId).runsFile;
  if (!existsSync(file)) return { file, run: undefined };
  const store = JSON.parse(readFileSync(file, "utf8")) as {
    runs: Array<{ runId: string; nextWake: string }>;
  };
  return { file, run: store.runs[0] };
}

describe("HK-024 next-wake on the run, fired by the stem", () => {
  it("keeps the RE fixture pin at 5091328 and does not rewrite field home or invent brand", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const source = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(source).toMatch(/5091328a2a5d4a9429ec65fef6da5683ede1cac9/);

    const fieldHome = readFileSync(path.join(process.cwd(), "src/surfaces/field.ts"), "utf8");
    expect(fieldHome).toMatch(/home\(tenantId: string, pack\?: LoadedPack\): FieldHome/);
    expect(fieldHome).toMatch(/architectControls: \[\]/);
    expect(fieldHome).not.toMatch(/nextWake|HK-024|fireDueNextWake/);
    const changed = changedFilesAgainstMain();
    if (changed) {
      expect(changed).not.toContain("src/surfaces/field.ts");
    }

    const identity = readFileSync(path.join(process.cwd(), "src/identity.ts"), "utf8");
    expect(identity).toMatch(/appDisplay: "AV Dev"/);
    expect(identity).toMatch(/"VEYRA"/);
    expect(identity).not.toMatch(/T0|T1|T2|T3/);

    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(/ADAPTER_UNBOUND/);
    expect(kernelSrc).toMatch(/this\.tickDue\(\)/);
    expect(kernelSrc).toMatch(/await this\.fireDueNextWake\(/);
    expect(kernelSrc).toMatch(/kind: "field_continue"/);
    expect(kernelSrc).not.toMatch(/nextWakeTicker|setInterval\([^)]*nextWake/);
    expect((kernelSrc.match(/setInterval\(/g) ?? []).length).toBe(1);

    const adapterSrc = readFileSync(path.join(process.cwd(), "src/habitat/adapter.ts"), "utf8");
    expect(adapterSrc).not.toMatch(/nextWake|wake\(|startDueTicker/);

    const orchSrc = readFileSync(path.join(process.cwd(), "src/agents/orchestrator.ts"), "utf8");
    expect(orchSrc).not.toMatch(/nextWake|setInterval|fireDue/);

    const deepSrc = readFileSync(path.join(process.cwd(), "src/habitat/deep-agents.ts"), "utf8");
    expect(deepSrc).toMatch(/owns = \["think"\]/);
    expect(deepSrc).not.toMatch(/fireDueNextWake|startDueTicker/);

    expect(WAKE_KINDS).toEqual([...CLOSED_V1]);
    expect(WAKE_KINDS).not.toContain("card_decided");
    expect(WAKE_KINDS).not.toContain("connector_event");
    expect(WAKE_KINDS).not.toContain("next_wake");
  });

  it("validated adapter decision sets run.nextWake; kernel persists it; restart still shows it", async () => {
    const due = "2026-08-17T12:00:00.000Z";
    const first = await habitatCore(scheduleOnStart(due));
    const started = await first.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: first.tenantId,
        pack: first.pack,
        goal: "one goal",
        recordId: first.record.id,
      },
      { until: "talking" },
    );
    expect(started.run?.nextWake).toBe(due);
    const onDisk = readDiskRun(first.computerBaseDir, first.tenantId);
    expect(existsSync(onDisk.file)).toBe(true);
    expect(onDisk.run?.runId).toBe(started.run?.runId);
    expect(onDisk.run?.nextWake).toBe(due);

    const second = new AlphaVectorCore(
      first.anchors,
      path.join(first.computerBaseDir, "state"),
      first.computerBaseDir,
    );
    const again = second.habitat.getRun(first.tenantId);
    expect(again?.runId).toBe(started.run?.runId);
    expect(again?.nextWake).toBe(due);
  });

  it("field-supplied or unvalidated nextWake is SURFACE_VIOLATION / fail-closed and is not persisted", async () => {
    const stack = await habitatCore();
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        nextWake: "2026-08-17T12:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(SurfaceViolationError);
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        nextWake: "2026-08-17T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    expect(stack.core.habitat.getRun(stack.tenantId)).toBeUndefined();
    expect(existsSync(computerRoot(stack.computerBaseDir, stack.tenantId).runsFile)).toBe(false);

    await expect(
      stack.core.habitat.observeFieldStart({
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        nextWake: "2026-08-17T12:00:00.000Z",
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
    expect(started.run?.nextWake).toBe("");
    await expect(
      stack.core.habitat.wake({
        kind: "field_ask",
        tenantId: stack.tenantId,
        pack: stack.pack,
        nextWake: "2026-08-17T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    expect(stack.core.habitat.getRun(stack.tenantId)?.nextWake).toBe("");
    expect(readDiskRun(stack.computerBaseDir, stack.tenantId).run?.nextWake).toBe("");

    const bad = await habitatCore(invalidNextWakeAdapter("not-a-time"));
    await expect(
      bad.core.habitat.wake(
        {
          kind: "field_start",
          tenantId: bad.tenantId,
          pack: bad.pack,
          goal: "one goal",
          recordId: bad.record.id,
        },
        { until: "talking" },
      ),
    ).rejects.toMatchObject({ code: "NEXT_WAKE_INVALID", closed: true });
    expect(bad.core.habitat.getRun(bad.tenantId)?.nextWake).toBe("");
    expect(readDiskRun(bad.computerBaseDir, bad.tenantId).run?.nextWake ?? "").toBe("");

    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hk024-http-"));
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
        nextWake: "2026-08-17T12:00:00.000Z",
      }),
    });
    expect(blockedStart.status).toBe(403);
    expect(((await blockedStart.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    expect(core.habitat.getRun("t1")).toBeUndefined();

    await field.start(kind, "http goal", record.id);
    expect(core.habitat.getRun("t1")?.nextWake).toBe("");
    const blockedContinue = await fetch(`${url}/field/continue`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ nextWake: "2026-08-17T12:00:00.000Z" }),
    });
    expect(blockedContinue.status).toBe(403);
    expect(((await blockedContinue.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    expect(core.habitat.getRun("t1")?.nextWake).toBe("");
  });

  it("stem fires a due nextWake as field_continue with a real HK-014 wake record on the same run", async () => {
    const due = "2026-08-17T12:00:00.000Z";
    const stack = await habitatCore(scheduleOnStart(due));
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
    const runId = started.run!.runId;
    expect(started.run?.nextWake).toBe(due);
    expect(stack.core.habitat.listWakes(stack.tenantId).map((w) => w.kind)).toEqual(["field_start"]);

    await stack.core.habitat.advanceClock(due);
    const after = stack.core.habitat.getRun(stack.tenantId);
    expect(after?.runId).toBe(runId);
    expect(after?.nextWake).toBe("");
    const wakes = stack.core.habitat.listWakes(stack.tenantId);
    const fired = wakes.find((w) => w.kind === "field_continue");
    expect(fired).toBeDefined();
    expect(fired?.run).toBe(runId);
    expect(fired?.runId).toBe(runId);
    expect(fired?.tenant).toBe(stack.tenantId);
    expect(fired?.kind).toBe("field_continue");
    expect(fired?.time).toEqual(expect.any(String));
    expect(fired?.time.length).toBeGreaterThan(0);
    expect(fired?.target).toEqual(expect.any(String));
    expect(fired?.target.length).toBeGreaterThan(0);
    expect(fired?.payloadHash).toBe(
      hashWakePayload({
        kind: fired!.kind,
        time: fired!.time,
        tenant: fired!.tenant,
        run: fired!.run,
        target: fired!.target,
        detail: fired!.detail,
      }),
    );

    await stack.core.habitat.advanceClock("2026-08-17T13:00:00.000Z");
    expect(stack.core.habitat.listWakes(stack.tenantId).filter((w) => w.kind === "field_continue")).toHaveLength(1);
    expect(stack.core.habitat.getRun(stack.tenantId)?.nextWake).toBe("");
  });

  it("empty nextWake fires nothing", async () => {
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
    expect(started.run?.nextWake).toBe("");
    const before = stack.core.habitat.listWakes(stack.tenantId).map((w) => w.kind);
    await stack.core.habitat.advanceClock(new Date().toISOString());
    expect(stack.core.habitat.listWakes(stack.tenantId).map((w) => w.kind)).toEqual(before);
    expect(stack.core.habitat.getRun(stack.tenantId)?.nextWake).toBe("");
    expect(stack.core.habitat.listWakes(stack.tenantId).some((w) => w.kind === "field_continue")).toBe(false);
  });

  it("a nextWake that arrives during an in-flight pass queues and does not interrupt (HK-013)", async () => {
    const due = "2026-08-17T12:00:00.000Z";
    const gate = gatedAfterSchedule(due, "field_ask", "talking");
    const stack = await habitatCore(gate.adapter);
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
    const runId = started.run!.runId;
    expect(started.run?.nextWake).toBe(due);

    const ask = stack.core.habitat.wake({
      kind: "field_ask",
      tenantId: stack.tenantId,
      pack: stack.pack,
    });
    await waitUntil(() => gate.entered());
    const clock = stack.core.habitat.advanceClock(due);
    await new Promise((r) => setTimeout(r, 40));
    expect(gate.order).toEqual(["field_start:talking", "field_ask:talking"]);
    expect(stack.core.habitat.listWakes(stack.tenantId).some((w) => w.kind === "field_continue")).toBe(false);
    expect(stack.core.habitat.getRun(stack.tenantId)?.runId).toBe(runId);
    expect(stack.core.habitat.getRun(stack.tenantId)?.status).not.toBe("killed");

    gate.release();
    const [askResult] = await Promise.all([ask, clock]);
    expect(askResult.run?.runId).toBe(runId);
    expect(gate.order).toEqual(["field_start:talking", "field_ask:talking", "field_continue:talking"]);
    const kinds = stack.core.habitat.listWakes(stack.tenantId).map((w) => w.kind);
    expect(kinds).toEqual(["field_start", "field_ask", "field_continue"]);
    expect(stack.core.habitat.getRun(stack.tenantId)?.runId).toBe(runId);
    expect(stack.core.habitat.getRun(stack.tenantId)?.nextWake).toBe("");
  });

  it("kill during a pass still cuts in (HK-060)", async () => {
    const gate = gatedThink("field_start", "worker");
    const stack = await habitatCore(gate.adapter);
    const first = stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { holdWorker: true },
    );
    await waitUntil(() => gate.order.includes("field_start:worker"));
    const runId = stack.core.habitat.getRun(stack.tenantId)!.runId;
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeDefined();

    const killed = await Promise.race([
      stack.core.habitat.wake({ kind: "kill", tenantId: stack.tenantId, reason: "stop" }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("kill was queued behind the in-flight pass")), 250);
      }),
    ]);
    expect(killed.run?.status).toBe("killed");
    expect(killed.run?.runId).toBe(runId);
    expect(stack.core.habitat.getRun(stack.tenantId)?.status).toBe("killed");
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();
    expect(stack.core.habitat.listWakes(stack.tenantId).some((w) => w.kind === "kill" && w.run === runId)).toBe(true);

    gate.release();
    const firstResult = await first;
    expect(firstResult.run?.status).toBe("killed");
    expect(stack.core.habitat.getRun(stack.tenantId)?.status).toBe("killed");
    expect(stack.core.habitat.getRun(stack.tenantId)?.runId).toBe(runId);
  });

  it("unbound adapter stays ADAPTER_UNBOUND; DryStem is fixture-only", async () => {
    const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk024-unbound-"));
    const { anchors, binding } = await signedGenericPack();
    const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir);
    const loaded = core.packs.load({ tenantId: "t1", binding, actor: "architect" });
    if (!loaded.ok) throw new Error(loaded.message);
    core.agents.instantiateFromPack(loaded.loaded, "architect");
    const record = core.records.put("t1", { type: "case", label: "Subject" });
    expect(core.habitat.cognitiveAdapterName()).toBe(new DeepAgentsAdapter().name);
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
  });
});
