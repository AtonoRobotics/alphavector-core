import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dryThink, DryStemAdapter } from "../src/habitat/adapter.js";
import { reapHeldCoders, WAKE_KINDS } from "../src/habitat/index.js";
import type { AdapterPass, CognitiveAdapter, WakeKind } from "../src/habitat/types.js";
import { AlphaVectorCore } from "../src/kernel.js";
import { ALPHAVECTOR_RE_PIN_SHA, REPO_ROOT, signedGenericPack } from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";

const CLOSED_V1_PLUS_EXISTING = new Set<string>([
  "field_start",
  "field_ask",
  "architect_message",
  "card_decided",
  "worker_done",
  "worker_failed",
  "deadline",
  "connector_event",
  "routine",
  "mail",
  "kill",
  "field_continue",
  "card_decide",
  "connector",
]);

afterEach(() => {
  reapHeldCoders();
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

function gatedThink(holdKind: WakeKind, holdPass: AdapterPass) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  let entered = false;
  const adapter: CognitiveAdapter = {
    name: "hk013-gate",
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

async function habitatCore(adapter: CognitiveAdapter = new DryStemAdapter()) {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk013-"));
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
    core,
    pack: loaded.loaded,
    tenantId: "t1" as const,
    agents,
    record,
  };
}

describe("HK-013 wake queue during a pass", () => {
  it("keeps the RE fixture pin at 5091328 and does not rewrite field home or invent brand", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const source = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(source).toMatch(/5091328a2a5d4a9429ec65fef6da5683ede1cac9/);

    const fieldHome = readFileSync(path.join(process.cwd(), "src/surfaces/field.ts"), "utf8");
    expect(fieldHome).toMatch(/home\(tenantId: string, pack\?: LoadedPack\): FieldHome/);
    expect(fieldHome).toMatch(/architectControls: \[\]/);
    expect(fieldHome).not.toMatch(/architect_message|worker_failed|HK-013/);

    const typesSrc = readFileSync(path.join(process.cwd(), "src/surfaces/types.ts"), "utf8");
    expect(typesSrc).toMatch(/export interface FieldHome/);
    expect(typesSrc).not.toMatch(/architect_message|worker_failed/);

    const identity = readFileSync(path.join(process.cwd(), "src/identity.ts"), "utf8");
    expect(identity).toMatch(/appDisplay: "Pyrallon"/);
    expect(identity).toMatch(/"VEYRA"/);

    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(/ADAPTER_UNBOUND/);
    expect(kernelSrc).toMatch(/event\.kind === "kill"/);

    const busSrc = readFileSync(path.join(process.cwd(), "src/habitat/wake-bus.ts"), "utf8");
    expect(busSrc).toMatch(/Emit-to-subscribers only/);
    expect(busSrc).not.toMatch(/enqueue|passTail|serializeWake/);

    expect(WAKE_KINDS).not.toContain("card_decided");
    expect(WAKE_KINDS).not.toContain("connector_event");
    for (const kind of WAKE_KINDS) {
      expect(CLOSED_V1_PLUS_EXISTING.has(kind), `unexpected WakeKind ${kind}`).toBe(true);
    }
  });

  it("queues a non-kill wake until the in-flight pass finishes, then runs it", async () => {
    const gate = gatedThink("field_start", "talking");
    const stack = await habitatCore(gate.adapter);
    const first = stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { until: "talking" },
    );
    await waitUntil(() => gate.entered());
    const runId = stack.core.habitat.getRun(stack.tenantId)!.runId;

    const queued = stack.core.habitat.wake({
      kind: "field_ask",
      tenantId: stack.tenantId,
      pack: stack.pack,
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(gate.order).toEqual(["field_start:talking"]);
    expect(stack.core.habitat.listWakes(stack.tenantId).some((w) => w.kind === "field_ask")).toBe(false);
    expect(stack.core.habitat.getRun(stack.tenantId)?.runId).toBe(runId);

    gate.release();
    const [firstResult, queuedResult] = await Promise.all([first, queued]);
    expect(firstResult.run?.runId).toBe(runId);
    expect(queuedResult.run?.runId).toBe(runId);
    expect(queuedResult.wokeOrchestrator).toBe(true);
    expect(gate.order).toEqual(["field_start:talking", "field_ask:talking"]);
    const kinds = stack.core.habitat.listWakes(stack.tenantId).map((w) => w.kind);
    expect(kinds.indexOf("field_start")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("field_ask")).toBeGreaterThan(kinds.indexOf("field_start"));
  });

  it("does not interrupt the in-flight pass: same run, worker is not torn down by the second wake", async () => {
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
    const workerId = stack.core.habitat.activeWorker(stack.tenantId)?.workerId;
    const pid = stack.core.habitat.activeWorker(stack.tenantId)?.pid;
    expect(workerId).toBeDefined();
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(true);

    const second = stack.core.habitat.wake({
      kind: "worker_done",
      tenantId: stack.tenantId,
      pack: stack.pack,
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(stack.core.habitat.getRun(stack.tenantId)?.runId).toBe(runId);
    expect(stack.core.habitat.activeWorker(stack.tenantId)?.workerId).toBe(workerId);
    expect(stack.core.habitat.activeWorker(stack.tenantId)?.pid).toBe(pid);
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(true);
    expect(stack.core.habitat.listWakes(stack.tenantId).some((w) => w.kind === "worker_done")).toBe(false);
    expect(gate.order.filter((m) => m.startsWith("worker_done"))).toEqual([]);

    gate.release();
    const firstResult = await first;
    expect(firstResult.run?.runId).toBe(runId);
    expect(firstResult.run?.status).not.toBe("killed");
    expect(firstResult.run?.status).not.toBe("completed");
    expect(stack.core.habitat.activeWorker(stack.tenantId)?.workerId).toBe(workerId);
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(true);

    await second;
    expect(stack.core.habitat.listWakes(stack.tenantId).some((w) => w.kind === "worker_done" && w.runId === runId)).toBe(
      true,
    );
  });

  it("kill during a pass takes effect immediately and is not queued (HK-060)", async () => {
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
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(true);

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
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(false);
    expect(stack.core.habitat.listWakes(stack.tenantId).some((w) => w.kind === "kill" && w.runId === runId)).toBe(true);

    gate.release();
    const firstResult = await first;
    expect(firstResult.run?.status).toBe("killed");
    expect(firstResult.run?.runId).toBe(runId);
    expect(stack.core.habitat.getRun(stack.tenantId)?.status).toBe("killed");
    expect(stack.core.habitat.getRun(stack.tenantId)?.runId).toBe(runId);
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(false);
  });

  it("drains queued wakes in arrival order after the in-flight pass", async () => {
    const gate = gatedThink("field_start", "talking");
    const stack = await habitatCore(gate.adapter);
    const first = stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { until: "talking" },
    );
    await waitUntil(() => gate.entered());
    const runId = stack.core.habitat.getRun(stack.tenantId)!.runId;

    const ask = stack.core.habitat.wake({
      kind: "field_ask",
      tenantId: stack.tenantId,
      pack: stack.pack,
    });
    const cont = stack.core.habitat.wake({
      kind: "field_continue",
      tenantId: stack.tenantId,
      pack: stack.pack,
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(gate.order).toEqual(["field_start:talking"]);
    expect(stack.core.habitat.listWakes(stack.tenantId).map((w) => w.kind)).toEqual(["field_start"]);

    gate.release();
    const [firstResult, askResult, contResult] = await Promise.all([first, ask, cont]);
    expect(firstResult.run?.runId).toBe(runId);
    expect(askResult.run?.runId).toBe(runId);
    expect(contResult.run?.runId).toBe(runId);
    expect(gate.order).toEqual(["field_start:talking", "field_ask:talking", "field_continue:talking"]);
    const kinds = stack.core.habitat.listWakes(stack.tenantId).map((w) => w.kind);
    expect(kinds).toEqual(["field_start", "field_ask", "field_continue"]);
  });
});
