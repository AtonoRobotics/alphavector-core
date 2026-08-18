import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { computerRoot } from "../src/computer/paths.js";
import { EvalRunner } from "../src/eval/runner.js";
import { AvError } from "../src/errors.js";
import { canonicalJson } from "../src/ids.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import {
  DeepAgentsAdapter,
  hashWakePayload,
  reapHeldCoders,
  recordWake,
  replayWakeLog,
  WAKE_KINDS,
  wakeTarget,
} from "../src/habitat/index.js";
import { stem } from "../src/habitat/stem.js";
import type { WakeLogEntry } from "../src/habitat/types.js";
import { AlphaVectorCore } from "../src/kernel.js";
import { ALPHAVECTOR_RE_PIN_SHA, REPO_ROOT, signedGenericPack } from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";

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

const REQUIRED = ["kind", "time", "tenant", "run", "target", "payloadHash"] as const;

afterEach(() => {
  reapHeldCoders();
});

async function habitatCore() {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk014-"));
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
    core,
    pack: loaded.loaded,
    tenantId: "t1" as const,
    agents,
    record,
    orch: agents.find((a) => a.isOrchestrator)!,
    role: agents.find((a) => !a.isOrchestrator)!,
  };
}

function expectSpine(entry: WakeLogEntry, runId: string): void {
  for (const field of REQUIRED) {
    expect(entry[field], `missing ${field}`).toEqual(expect.any(String));
    expect(String(entry[field]).length, `empty ${field}`).toBeGreaterThan(0);
  }
  expect(entry.run).toBe(runId);
  expect(entry.runId).toBe(runId);
  expect(entry.tenant).toBe(entry.tenantId);
  expect(entry.time).toBe(entry.at);
  expect(entry.payloadHash).toBe(
    hashWakePayload({
      kind: entry.kind,
      time: entry.time,
      tenant: entry.tenant,
      run: entry.run,
      target: entry.target,
      detail: entry.detail,
    }),
  );
  const decisionHash = createHash("sha256").update(canonicalJson(entry.decision), "utf8").digest("hex");
  expect(entry.payloadHash).not.toBe(decisionHash);
}

function readDiskLog(computerBaseDir: string, tenantId: string): { entries: WakeLogEntry[] } {
  return JSON.parse(readFileSync(computerRoot(computerBaseDir, tenantId).wakeLogFile, "utf8")) as {
    entries: WakeLogEntry[];
  };
}

describe("HK-014 immutable wake log", () => {
  it("keeps the RE fixture pin at 5091328 and does not rewrite field home or invent brand", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const source = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(source).toMatch(/5091328a2a5d4a9429ec65fef6da5683ede1cac9/);

    const fieldHome = readFileSync(path.join(process.cwd(), "src/surfaces/field.ts"), "utf8");
    expect(fieldHome).toMatch(/home\(tenantId: string, pack\?: LoadedPack\): FieldHome/);
    expect(fieldHome).toMatch(/architectControls: \[\]/);
    expect(fieldHome).not.toMatch(/payloadHash|HK-014|WAKE_LOG|wake-log|wakeLog/);
    const changed = changedFilesAgainstMain();
    if (changed) {
      expect(changed).not.toContain("src/surfaces/field.ts");
    }

    const identity = readFileSync(path.join(process.cwd(), "src/identity.ts"), "utf8");
    expect(identity).toMatch(/appDisplay: "Pyrallon"/);
    expect(identity).toMatch(/"VEYRA"/);

    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(/ADAPTER_UNBOUND/);

    expect(WAKE_KINDS).not.toContain("card_decided");
    expect(WAKE_KINDS).not.toContain("connector_event");
    for (const kind of WAKE_KINDS) {
      expect(CLOSED_V1_PLUS_EXISTING.has(kind), `unexpected WakeKind ${kind}`).toBe(true);
    }
  });

  it("every persisted wake has kind, time, tenant, run, target, payloadHash; field_start writes the run it created", async () => {
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
    const runId = started.run!.runId;
    expect(runId).toMatch(/^run_/);

    await stack.core.habitat.wake({
      kind: "field_ask",
      tenantId: stack.tenantId,
      pack: stack.pack,
    });
    await stack.core.habitat.wake({
      kind: "card_decide",
      tenantId: stack.tenantId,
      pack: stack.pack,
      cardId: "card_probe",
      decision: "approved",
    });
    await stack.core.habitat.reportWorkerFailed({
      tenantId: stack.tenantId,
      workerId: "worker_held",
      reason: "held coder failed",
    });
    await stack.core.habitat.deliverMail({
      tenantId: stack.tenantId,
      addresseeId: stack.role.agentId,
      fromAgentId: stack.orch.agentId,
      body: "status",
      deliveredBy: "habitat",
    });
    await stack.core.habitat.wake({ kind: "kill", tenantId: stack.tenantId, reason: "stop" });

    const wakes = stack.core.habitat.listWakes(stack.tenantId);
    expect(wakes.length).toBeGreaterThanOrEqual(5);
    expect(wakes[0]?.kind).toBe("field_start");
    expect(wakes[0]?.run).toBe(runId);

    const byKind = new Map(wakes.map((w) => [w.kind, w]));
    expect(byKind.get("field_start")?.target).toBe("orchestrator");
    expect(byKind.get("field_ask")?.target).toBe("orchestrator");
    expect(byKind.get("card_decide")?.target).toBe("ops");
    expect(byKind.get("worker_failed")?.target).toBe("worker_held");
    expect(byKind.get("mail")?.target).toBe(stack.role.agentId);
    expect(byKind.get("kill")?.target).toBe("orchestrator");

    for (const entry of wakes) {
      expectSpine(entry, runId);
      expect(["orchestrator", "ops", stack.role.agentId, "worker", "worker_held"]).toContain(entry.target);
    }

    const onDisk = readDiskLog(stack.computerBaseDir, stack.tenantId);
    expect(onDisk.entries).toHaveLength(wakes.length);
    for (const entry of onDisk.entries) {
      expectSpine(entry, runId);
    }
  });

  it("payloadHash covers the wake payload, not the stem decision; a hash change is WAKE_LOG_MISMATCH", async () => {
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
    const file = computerRoot(stack.computerBaseDir, stack.tenantId).wakeLogFile;
    expect(existsSync(file)).toBe(true);
    const log = readDiskLog(stack.computerBaseDir, stack.tenantId);
    const first = log.entries[0]!;
    expect(first.payloadHash).toBe(
      hashWakePayload({
        kind: first.kind,
        time: first.time,
        tenant: first.tenant,
        run: first.run,
        target: first.target,
        detail: first.detail,
      }),
    );
    expect(first.payloadHash).not.toBe(
      createHash("sha256").update(canonicalJson(first.decision), "utf8").digest("hex"),
    );

    first.payloadHash = "0".repeat(64);
    writeFileSync(file, `${JSON.stringify(log)}\n`, "utf8");
    const replayed = new EvalRunner().replayFacilities({
      computerBaseDir: stack.computerBaseDir,
      tenantId: stack.tenantId,
    });
    expect(replayed.passed).toBe(false);
    expect(replayed.error).toBe("WAKE_LOG_MISMATCH");
  });

  it("changing a prior seq or required field on disk is WAKE_LOG_MISMATCH", async () => {
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
    await stack.core.habitat.wake({
      kind: "field_ask",
      tenantId: stack.tenantId,
      pack: stack.pack,
    });
    const file = computerRoot(stack.computerBaseDir, stack.tenantId).wakeLogFile;
    const seqTamper = readDiskLog(stack.computerBaseDir, stack.tenantId);
    seqTamper.entries[0]!.seq = 99;
    writeFileSync(file, `${JSON.stringify(seqTamper)}\n`, "utf8");
    const seqReplay = new EvalRunner().replayFacilities({
      computerBaseDir: stack.computerBaseDir,
      tenantId: stack.tenantId,
    });
    expect(seqReplay.passed).toBe(false);
    expect(seqReplay.error).toBe("WAKE_LOG_MISMATCH");

    const fresh = await habitatCore();
    await fresh.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: fresh.tenantId,
        pack: fresh.pack,
        goal: "one goal",
        recordId: fresh.record.id,
      },
      { until: "talking" },
    );
    const freshFile = computerRoot(fresh.computerBaseDir, fresh.tenantId).wakeLogFile;
    const missing = readDiskLog(fresh.computerBaseDir, fresh.tenantId);
    delete (missing.entries[0] as { tenant?: string }).tenant;
    writeFileSync(freshFile, `${JSON.stringify(missing)}\n`, "utf8");
    const missingReplay = new EvalRunner().replayFacilities({
      computerBaseDir: fresh.computerBaseDir,
      tenantId: fresh.tenantId,
    });
    expect(missingReplay.passed).toBe(false);
    expect(missingReplay.error).toBe("WAKE_LOG_MISMATCH");
  });

  it("a later append does not mutate a prior entry", async () => {
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
    const before = structuredClone(stack.core.habitat.listWakes(stack.tenantId)[0]);
    const diskBefore = structuredClone(readDiskLog(stack.computerBaseDir, stack.tenantId).entries[0]);
    expect(before?.seq).toBe(1);

    await stack.core.habitat.wake({
      kind: "field_ask",
      tenantId: stack.tenantId,
      pack: stack.pack,
    });
    const after = stack.core.habitat.listWakes(stack.tenantId);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before);
    expect(after[1]?.seq).toBe(2);
    expect(readDiskLog(stack.computerBaseDir, stack.tenantId).entries[0]).toEqual(diskBefore);
  });

  it("Safety replay stays stem() only — no model, no adapter, invocations do not rise", async () => {
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
    await stack.core.habitat.wake({
      kind: "field_ask",
      tenantId: stack.tenantId,
      pack: stack.pack,
    });

    const before = DeepAgentsAdapter.invocations;
    const replayed = stack.core.habitat.replay(stack.tenantId);
    expect(replayed.passed).toBe(true);
    expect(replayed.kinds).toEqual(["field_start", "field_ask"]);
    expect(DeepAgentsAdapter.invocations).toBe(before);

    const evalReplay = new EvalRunner().replayFacilities({
      computerBaseDir: stack.computerBaseDir,
      tenantId: stack.tenantId,
    });
    expect(evalReplay.passed).toBe(true);
    expect(DeepAgentsAdapter.invocations).toBe(before);

    const replaySrc = readFileSync(path.join(process.cwd(), "src/habitat/wake-log.ts"), "utf8");
    expect(replaySrc).toMatch(/stem\(/);
    expect(replaySrc).toMatch(/stemDecisionsEqual/);
    expect(replaySrc).not.toMatch(/createDeepAgent|\.think\(/);
    const evalSrc = readFileSync(path.join(process.cwd(), "src/eval/runner.ts"), "utf8");
    expect(evalSrc).not.toMatch(/createDeepAgent|\.think\(/);
  });

  it("wakeTarget derives orchestrator / ops / addressee / worker and recordWake refuses a missing run", () => {
    expect(wakeTarget({ kind: "field_start", tenantId: "t1" }, stem({ kind: "field_start", tenantId: "t1" }))).toBe(
      "orchestrator",
    );
    expect(
      wakeTarget(
        { kind: "card_decide", tenantId: "t1", decision: "approved" },
        stem({ kind: "card_decide", tenantId: "t1", decision: "approved" }),
      ),
    ).toBe("ops");
    expect(
      wakeTarget({ kind: "mail", tenantId: "t1", addresseeId: "agent_role" }, stem({ kind: "mail", tenantId: "t1" })),
    ).toBe("agent_role");
    expect(
      wakeTarget(
        { kind: "worker_done", tenantId: "t1", workerId: "w_1" },
        stem({ kind: "worker_done", tenantId: "t1" }),
      ),
    ).toBe("w_1");
    expect(wakeTarget({ kind: "worker_failed", tenantId: "t1" }, stem({ kind: "worker_failed", tenantId: "t1" }))).toBe(
      "worker",
    );

    expect(() =>
      recordWake({
        kind: "field_start",
        tenantId: "t1",
        run: "",
        target: "orchestrator",
        decision: { wakeOrchestrator: true, wakeOps: false },
      }),
    ).toThrow(AvError);

    const inMemory = replayWakeLog([
      {
        seq: 1,
        kind: "field_start",
        tenantId: "t1",
        at: "2026-08-16T00:00:00.000Z",
        decision: { wakeOrchestrator: true, wakeOps: false },
      },
    ]);
    expect(inMemory.passed).toBe(false);
    expect(inMemory.error).toBe("WAKE_LOG_MISMATCH");
  });
});
