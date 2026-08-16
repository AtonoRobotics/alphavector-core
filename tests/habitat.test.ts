import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryTiers } from "../src/agents/memory.js";
import { computerRoot } from "../src/computer/paths.js";
import { EvalRunner } from "../src/eval/runner.js";
import { AvError } from "../src/errors.js";
import { architectBindAdapter } from "../src/auth/architect-adapter-bind.js";
import { architectIssueFieldToken } from "../src/auth/architect-field-token.js";
import {
  createDeepAgent,
  DeepAgentsAdapter,
  DryStemAdapter,
  HABITAT_OWNED,
  isPidAlive,
  reapHeldCoders,
  resetDeepAgentsInvocations,
  WorkerBook,
} from "../src/habitat/index.js";
import { FieldClient, FieldHttpError } from "../src/http/field-client.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { startFieldServe } from "../src/http/field-listen.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import type { CognitiveAdapter } from "../src/habitat/types.js";
import { AlphaVectorCore } from "../src/kernel.js";
import type { PackBinding } from "../src/packs/types.js";
import { RecordBook } from "../src/records/book.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  createOpenStart,
  expectPresentIdsDeniedWithoutRecord,
  makeAnchors,
  signedGenericPack,
  signedGenericPackMutated,
  signedRePackMutated,
} from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const servers: FieldHttpServer[] = [];

/** Wait until the booked pid is gone (or a zombie). */
function waitForPidDead(pid: number | undefined, ms = 2000): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return !isPidAlive(pid);
}

/** Kill the coder pid without teardown so the book and trailer stay (leftover). */
function killPidLeaveBook(pid: number | undefined): void {
  if (pid && isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  expect(waitForPidDead(pid)).toBe(true);
}

afterEach(async () => {
  resetDeepAgentsInvocations();
  reapHeldCoders();
  while (servers.length) {
    await servers.pop()?.close();
  }
});

async function habitatStack(tenantId = "t1") {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-habitat-"));
  const { anchors, binding } = await signedGenericPack();
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir, {
    adapter: new DryStemAdapter(),
  });
  const loaded = core.packs.load({ tenantId, binding, actor: "architect" });
  if (!loaded.ok) throw new Error(loaded.message);
  const agents = core.agents.instantiateFromPack(loaded.loaded, "architect");
  const record = core.records.put(tenantId, { type: "case", label: "Subject" });
  return {
    computerBaseDir,
    anchors,
    core,
    pack: loaded.loaded,
    tenantId,
    agents,
    record,
  };
}

async function habitatThinkStack(
  tenantId = "t1",
  mutate?: (unsigned: Omit<PackBinding, "signatures">) => void,
) {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-think-"));
  const { anchors, binding } = mutate
    ? await signedGenericPackMutated(mutate)
    : await signedGenericPack();
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir);
  const loaded = core.packs.load({ tenantId, binding, actor: "architect" });
  if (!loaded.ok) throw new Error(loaded.message);
  const agents = core.agents.instantiateFromPack(loaded.loaded, "architect");
  const record = core.records.put(tenantId, { type: "case", label: "Subject" });
  const architect = core.fieldTokens.issue({ tenantId, principal: "architect" });
  const field = core.fieldTokens.issue({
    tenantId,
    principal: "field",
    presented: architect.token,
  });
  return {
    computerBaseDir,
    anchors,
    core,
    pack: loaded.loaded,
    tenantId,
    agents,
    record,
    architectToken: architect.token,
    fieldToken: field.token,
  };
}

async function liveField(
  tenantId: string,
  computerBaseDir: string,
  issued?: { field: string; architect?: string },
  adapter: CognitiveAdapter = new DryStemAdapter(),
) {
  const { core, pack } = await bootFieldCore(tenantId, { computerBaseDir, adapter });
  let fieldToken = issued?.field;
  let architectToken = issued?.architect;
  if (!fieldToken) {
    const architect = core.fieldTokens.issue({ tenantId, principal: "architect" });
    architectToken = architect.token;
    fieldToken = core.fieldTokens.issue({
      tenantId,
      principal: "field",
      presented: architect.token,
    }).token;
  }
  const server = new FieldHttpServer({ core, pack, tenantId });
  servers.push(server);
  const { url } = await server.listen(0, "127.0.0.1");
  return {
    core,
    pack,
    field: new FieldClient(url, fieldToken),
    fieldToken,
    architectToken,
    url,
    server,
  };
}

/** Product boot: no adapter option. DeepAgentsAdapter is the field-serve default. */
async function liveProductField(
  tenantId: string,
  computerBaseDir: string,
  issued?: { field: string; architect?: string },
) {
  const { core, pack } = await bootFieldCore(tenantId, { computerBaseDir });
  let fieldToken = issued?.field;
  let architectToken = issued?.architect;
  if (!fieldToken) {
    const architect = core.fieldTokens.issue({ tenantId, principal: "architect" });
    architectToken = architect.token;
    fieldToken = core.fieldTokens.issue({
      tenantId,
      principal: "field",
      presented: architect.token,
    }).token;
  }
  const server = new FieldHttpServer({ core, pack, tenantId });
  servers.push(server);
  const { url } = await server.listen(0, "127.0.0.1");
  return {
    core,
    pack,
    field: new FieldClient(url, fieldToken),
    fieldToken,
    architectToken,
    url,
    server,
  };
}

describe("D10 §6 habitat kernel", () => {
  it("keeps the RE fixture pin at 5091328", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
  });

  it("field start creates a durable run on disk and wakes the orchestrator", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-field-"));
    const { core, field } = await liveField("t1", dir);
    const { journey } = await createOpenStart(field, "buyer", "Work this buyer journey");
    const run = core.habitat.getRun("t1");
    expect(run).toBeDefined();
    expect(run!.goal).toBe(journey.objective);
    expect(run!.runId).toMatch(/^run_/);
    expect(existsSync(computerRoot(dir, "t1").runsFile)).toBe(true);
    expect(existsSync(computerRoot(dir, "t1").workersFile)).toBe(true);
    expect(existsSync(path.join(computerRoot(dir, "t1").disk, "runs.json"))).toBe(false);
    expect(existsSync(path.join(computerRoot(dir, "t1").disk, "workers.json"))).toBe(false);
    const wakes = core.habitat.listWakes("t1");
    expect(wakes.some((w) => w.kind === "field_start")).toBe(true);
    expect(core.habitat.trailerExists("t1")).toBe(true);
    expect(run!.talkingDidHeavyWork).toBe(false);
    expect(run!.status).toBe("awaiting_card");
    const worker = core.habitat.activeWorker("t1");
    expect(worker?.pid).toBeDefined();
    expect(isPidAlive(worker?.pid)).toBe(true);
    expect(new WorkerBook(dir).isLive("t1")).toBe(true);
  });

  it("fixture start wakes stem, talking does not do heavy work, worker is the coder", async () => {
    const { core, pack, tenantId, record } = await habitatStack();
    const talking = core.habitat.wake(
      {
        kind: "field_start",
        tenantId,
        pack,
        goal: "one goal",
        recordId: record.id,
      },
      { until: "talking" },
    );
    expect(talking.wokeOrchestrator).toBe(true);
    expect(talking.launchedWorker).toBe(false);
    expect(talking.talkingDidHeavyWork).toBe(false);
    expect(core.habitat.trailerExists(tenantId)).toBe(false);
    expect(talking.run?.status).toBe("talking");

    const working = core.habitat.wake({
      kind: "field_start",
      tenantId,
      pack,
      goal: "one goal",
      recordId: record.id,
    });
    expect(working.launchedWorker).toBe(true);
    expect(working.run?.workerType).toBe("coder");
    expect(working.run?.workerId).toMatch(/^worker_/);
    expect(working.run?.status).toBe("awaiting_card");
    expect(working.cardId).toMatch(/^card_/);
    expect(core.habitat.trailerExists(tenantId)).toBe(true);
    expect(core.habitat.waitForExecutor(tenantId)).toBe(true);
    const worker = core.habitat.activeWorker(tenantId);
    expect(worker?.type).toBe("coder");
    expect(worker?.isolation).toBe("trailer");
    expect(existsSync(path.join(worker!.trailerPath, ".branch"))).toBe(true);
    expect(readFileSync(path.join(worker!.trailerPath, ".branch"), "utf8")).toContain("coder/");
    expect(working.talkingDidHeavyWork).toBe(false);
  });

  it("Deep Agents is imported as adapter and does not own the loop", async () => {
    expect(typeof createDeepAgent).toBe("function");
    expect(DeepAgentsAdapter.sdkEntry).toBe(createDeepAgent);
    expect(DeepAgentsAdapter.invocations).toBe(0);
    const adapter = new DeepAgentsAdapter();
    expect(adapter.owns).toEqual(["think"]);
    expect(adapter.name).toBe("deepagents");

    const { core, pack, tenantId, record } = await habitatStack();
    expect(core.habitat.owns).toEqual([...HABITAT_OWNED]);
    core.habitat.wake({
      kind: "field_start",
      tenantId,
      pack,
      goal: "one goal",
      recordId: record.id,
    });
    expect(DeepAgentsAdapter.invocations).toBe(0);
    expect(core.habitat.getRun(tenantId)?.runId).toMatch(/^run_/);
    expect(core.habitat.listWakes(tenantId).length).toBeGreaterThan(0);
    const src = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(src).not.toMatch(/createDeepAgent\s*\(/);
    expect(src).not.toMatch(/from ["']dcode["']/);
    const adapterSrc = readFileSync(path.join(process.cwd(), "src/habitat/deep-agents.ts"), "utf8");
    expect(adapterSrc).toMatch(/from ["']deepagents["']/);
    expect(adapterSrc).not.toMatch(/from ["']dcode["']/);
    expect(adapterSrc).not.toMatch(/dryThink/);
    expect(adapterSrc).not.toMatch(/createDeepAgent\s*\(/);
  });

  it("worker_done wakes ops and one card is required for one external effect", async () => {
    const { core, pack, tenantId, record } = await habitatStack();
    const started = core.habitat.wake({
      kind: "field_start",
      tenantId,
      pack,
      goal: "one goal",
      recordId: record.id,
    });
    expect(started.cardId).toBeDefined();
    expect(started.effect).toBeUndefined();
    expect(core.cards.get(started.cardId!)?.status).toBe("pending");
    expect(core.store.actions.filter((a) => a.status === "executed")).toHaveLength(0);

    core.cards.resolve({ cardId: started.cardId!, decision: "approved", actor: "field" });
    const approved = core.habitat.wake({
      kind: "card_decide",
      tenantId,
      pack,
      cardId: started.cardId,
      decision: "approved",
    });
    expect(approved.effect?.executed).toBe(true);
    expect(approved.wokeOps).toBe(true);
    expect(approved.run?.status).toBe("completed");
    expect(core.habitat.listWakes(tenantId).some((w) => w.kind === "worker_done")).toBe(true);
    expect(core.habitat.trailerExists(tenantId)).toBe(false);
  });

  it("unapproved and denied effects do not persist; deny is terminal", async () => {
    const { core, pack, tenantId, record } = await habitatStack();
    const started = core.habitat.wake({
      kind: "field_start",
      tenantId,
      pack,
      goal: "one goal",
      recordId: record.id,
    });
    expect(core.store.actions.some((a) => a.status === "executed")).toBe(false);
    core.cards.resolve({ cardId: started.cardId!, decision: "denied", actor: "field" });
    const denied = core.habitat.wake({
      kind: "card_decide",
      tenantId,
      pack,
      cardId: started.cardId,
      decision: "denied",
    });
    expect(denied.run?.status).toBe("denied");
    expect(denied.effect).toBeUndefined();
    expect(core.store.actions.some((a) => a.status === "executed")).toBe(false);
    const deniedAgentId = started.run!.pendingEffect!.agentId;
    expect(
      core.cards.wasDenied(tenantId, deniedAgentId, "communicate", record.id, "email"),
    ).toBe(true);
  });

  it("approve resumes the same run id on disk", async () => {
    const { core, pack, tenantId, record } = await habitatStack();
    const started = core.habitat.wake({
      kind: "field_start",
      tenantId,
      pack,
      goal: "one goal",
      recordId: record.id,
    });
    const runId = started.run!.runId;
    core.cards.resolve({ cardId: started.cardId!, decision: "approved", actor: "field" });
    const approved = core.habitat.wake({
      kind: "card_decide",
      tenantId,
      pack,
      cardId: started.cardId,
      decision: "approved",
    });
    expect(approved.run?.runId).toBe(runId);
    expect(core.habitat.getRun(tenantId)?.runId).toBe(runId);
  });

  it("restart of core objects on the same computerBaseDir still sees the same run and pending card", async () => {
    const first = await habitatStack("restart");
    first.core.habitat.memory.writeProfile({
      tenantId: "restart",
      agentId: first.agents[0]!.agentId,
      note: "profile-note",
    });
    const started = first.core.habitat.wake({
      kind: "field_start",
      tenantId: "restart",
      pack: first.pack,
      goal: "one goal",
      recordId: first.record.id,
    });
    const runId = started.run!.runId;
    const cardId = started.cardId!;

    const records = new RecordBook(first.computerBaseDir);
    const second = new AlphaVectorCore(
      first.anchors,
      path.join(first.computerBaseDir, "state"),
      first.computerBaseDir,
    );
    expect(records.get("restart", first.record.id)?.id).toBe(first.record.id);
    expect(second.habitat.getRun("restart")?.runId).toBe(runId);
    expect(second.habitat.getRun("restart")?.pendingCardId).toBe(cardId);
    expect(second.habitat.activeWorker("restart")?.workerId).toBe(started.run?.workerId);
    expect(second.habitat.activeWorker("restart")?.type).toBe("coder");
    expect(second.habitat.activeWorker("restart")?.trailerPath).toBe(
      first.core.habitat.activeWorker("restart")?.trailerPath,
    );
    expect(second.habitat.activeWorker("restart")?.branch).toBe(
      first.core.habitat.activeWorker("restart")?.branch,
    );
    second.cards.hydrateTenant("restart");
    expect(second.cards.get(cardId)?.status).toBe("pending");
    expect(second.habitat.memory.loadProfile("restart", first.agents[0]!.agentId)?.notes).toContain(
      "profile-note",
    );
  });

  it("kill tears the worker down (trailer gone)", async () => {
    const { core, pack, tenantId, record } = await habitatStack();
    core.habitat.wake(
      {
        kind: "field_start",
        tenantId,
        pack,
        goal: "one goal",
        recordId: record.id,
      },
      { holdWorker: true },
    );
    expect(core.habitat.trailerExists(tenantId)).toBe(true);
    const killed = core.habitat.wake({ kind: "kill", tenantId, reason: "stop" });
    expect(killed.run?.status).toBe("killed");
    expect(core.habitat.trailerExists(tenantId)).toBe(false);
    expect(core.habitat.activeWorker(tenantId)).toBeUndefined();
  });

  it("wake log can be replayed with no model", async () => {
    const { core, pack, tenantId, record } = await habitatStack();
    core.habitat.wake(
      {
        kind: "field_start",
        tenantId,
        pack,
        goal: "one goal",
        recordId: record.id,
      },
      { until: "talking" },
    );
    const replayed = core.habitat.replay(tenantId);
    expect(replayed.passed).toBe(true);
    expect(replayed.kinds).toContain("field_start");
    const evalReplay = new EvalRunner().replayFacilities(core.habitat.listWakes(tenantId));
    expect(evalReplay.passed).toBe(true);
    expect(evalReplay.kinds).toEqual(replayed.kinds);
  });

  it("HTTP start then ask, replayFacilities on tenant disk log passes without a model", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-replay-http-"));
    const { core, field } = await liveField("t1", dir);
    expect(DeepAgentsAdapter.invocations).toBe(0);
    await createOpenStart(field, "buyer", "Work this buyer journey");
    const run = core.habitat.getRun("t1");
    expect(run?.runId).toMatch(/^run_/);
    await field.ask("status?", "read");
    expect(existsSync(computerRoot(dir, "t1").wakeLogFile)).toBe(true);
    expect(existsSync(computerRoot(dir, "t1").runsFile)).toBe(true);

    const before = DeepAgentsAdapter.invocations;
    const replayed = new EvalRunner().replayFacilities({ computerBaseDir: dir, tenantId: "t1" });
    expect(replayed.passed).toBe(true);
    expect(replayed.error).toBeUndefined();
    expect(replayed.kinds).toContain("field_start");
    expect(replayed.kinds).toContain("field_ask");
    expect(replayed.runIds).toEqual([run!.runId]);
    expect(DeepAgentsAdapter.invocations).toBe(before);

    const onDisk = JSON.parse(readFileSync(computerRoot(dir, "t1").wakeLogFile, "utf8")) as {
      entries: Array<{ kind: string; decision?: { wakeOrchestrator: boolean; wakeOps: boolean } }>;
    };
    expect(onDisk.entries.length).toBeGreaterThan(0);
    expect(onDisk.entries.some((e) => e.kind === "field_start")).toBe(true);
    expect(onDisk.entries.some((e) => e.kind === "field_ask")).toBe(true);
    for (const entry of onDisk.entries) {
      expect(entry.decision).toEqual({
        wakeOrchestrator: expect.any(Boolean),
        wakeOps: expect.any(Boolean),
      });
    }

    const replaySrc = readFileSync(path.join(process.cwd(), "src/habitat/wake-log.ts"), "utf8");
    expect(replaySrc).toMatch(/stem\(/);
    expect(replaySrc).toMatch(/stemDecisionsEqual/);
    expect(replaySrc).not.toMatch(/createDeepAgent|\.think\(/);
    const evalSrc = readFileSync(path.join(process.cwd(), "src/eval/runner.ts"), "utf8");
    expect(evalSrc).not.toMatch(/createDeepAgent|\.think\(/);
  });

  it("HTTP start then ask, tampered stored stem decision fails replay with WAKE_LOG_MISMATCH", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-replay-tamper-"));
    const { field } = await liveField("t1", dir);
    await createOpenStart(field, "buyer", "Work this buyer journey");
    await field.ask("status?", "read");
    const wakeLogFile = computerRoot(dir, "t1").wakeLogFile;
    const log = JSON.parse(readFileSync(wakeLogFile, "utf8")) as {
      entries: Array<{ kind: string; decision: { wakeOrchestrator: boolean; wakeOps: boolean } }>;
    };
    const target = log.entries.find((e) => e.kind === "field_ask") ?? log.entries[0];
    expect(target.decision).toBeDefined();
    target.decision.wakeOps = !target.decision.wakeOps;
    writeFileSync(wakeLogFile, `${JSON.stringify(log)}\n`, "utf8");

    const replayed = new EvalRunner().replayFacilities({ computerBaseDir: dir, tenantId: "t1" });
    expect(replayed.passed).toBe(false);
    expect(replayed.error).toBe("WAKE_LOG_MISMATCH");
  });

  it("HTTP start then ask, missing stored stem decision fails replay closed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-replay-no-decision-"));
    const { field } = await liveField("t1", dir);
    await createOpenStart(field, "buyer", "Work this buyer journey");
    await field.ask("status?", "read");
    const wakeLogFile = computerRoot(dir, "t1").wakeLogFile;
    const log = JSON.parse(readFileSync(wakeLogFile, "utf8")) as {
      entries: Array<{ kind: string; decision?: { wakeOrchestrator: boolean; wakeOps: boolean } }>;
    };
    const target = log.entries.find((e) => e.kind === "field_start") ?? log.entries[0];
    delete target.decision;
    writeFileSync(wakeLogFile, `${JSON.stringify(log)}\n`, "utf8");

    const replayed = new EvalRunner().replayFacilities({ computerBaseDir: dir, tenantId: "t1" });
    expect(replayed.passed).toBe(false);
    expect(replayed.error).toBe("WAKE_LOG_MISMATCH");
  });

  it("missing wake-log file fails closed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-replay-missing-"));
    expect(existsSync(computerRoot(dir, "t1").wakeLogFile)).toBe(false);
    try {
      new EvalRunner().replayFacilities({ computerBaseDir: dir, tenantId: "t1" });
      expect.fail("missing wake log must fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(AvError);
      expect(err).toMatchObject({ code: "WAKE_LOG_MISSING", closed: true });
    }
  });

  it("corrupt wake-log JSON fails closed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-replay-corrupt-"));
    const wakeLogFile = computerRoot(dir, "t1").wakeLogFile;
    mkdirSync(path.dirname(wakeLogFile), { recursive: true });
    writeFileSync(wakeLogFile, "{not-json", "utf8");
    try {
      new EvalRunner().replayFacilities({ computerBaseDir: dir, tenantId: "t1" });
      expect.fail("corrupt wake log must fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(AvError);
      expect(err).toMatchObject({ code: "WAKE_LOG_CORRUPT", closed: true });
    }
  });

  it("mismatched wake log fails closed", async () => {
    const runner = new EvalRunner();
    const at = "2026-08-16T00:00:00.000Z";
    const empty = runner.replayFacilities([]);
    expect(empty.passed).toBe(false);
    expect(empty.error).toBe("WAKE_LOG_EMPTY");

    const fieldAskDecision = { wakeOrchestrator: true, wakeOps: false };
    const unknown = runner.replayFacilities([
      { seq: 1, kind: "not_a_kind" as "field_start", tenantId: "t1", at, decision: fieldAskDecision },
    ]);
    expect(unknown.passed).toBe(false);
    expect(unknown.error).toBe("WAKE_LOG_MISMATCH");

    const askWithoutRun = runner.replayFacilities([
      { seq: 1, kind: "field_ask", tenantId: "t1", at, decision: fieldAskDecision },
    ]);
    expect(askWithoutRun.passed).toBe(false);
    expect(askWithoutRun.error).toBe("WAKE_LOG_MISMATCH");

    const missingDecision = runner.replayFacilities([{ seq: 1, kind: "field_start", tenantId: "t1", at } as never]);
    expect(missingDecision.passed).toBe(false);
    expect(missingDecision.error).toBe("WAKE_LOG_MISMATCH");

    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-replay-mismatch-"));
    const paths = computerRoot(dir, "t1");
    mkdirSync(path.dirname(paths.wakeLogFile), { recursive: true });
    writeFileSync(
      paths.wakeLogFile,
      `${JSON.stringify({
        entries: [
          {
            seq: 1,
            kind: "field_ask",
            tenantId: "t1",
            runId: "run_other",
            at,
            decision: { wakeOrchestrator: true, wakeOps: false },
          },
        ],
      })}\n`,
      "utf8",
    );
    writeFileSync(
      paths.runsFile,
      `${JSON.stringify({
        runs: [
          {
            runId: "run_real",
            tenantId: "t1",
            goal: "one goal",
            status: "open",
            talkingDidHeavyWork: false,
            createdAt: at,
            updatedAt: at,
          },
        ],
      })}\n`,
      "utf8",
    );
    const mismatchedRun = runner.replayFacilities({ computerBaseDir: dir, tenantId: "t1" });
    expect(mismatchedRun.passed).toBe(false);
    expect(mismatchedRun.error).toBe("WAKE_LOG_MISMATCH");

    const emptyDir = await mkdtemp(path.join(os.tmpdir(), "av-hab-replay-empty-"));
    const emptyFile = computerRoot(emptyDir, "t1").wakeLogFile;
    mkdirSync(path.dirname(emptyFile), { recursive: true });
    writeFileSync(emptyFile, `${JSON.stringify({ entries: [] })}\n`, "utf8");
    const emptyDisk = runner.replayFacilities({ computerBaseDir: emptyDir, tenantId: "t1" });
    expect(emptyDisk.passed).toBe(false);
    expect(emptyDisk.error).toBe("WAKE_LOG_EMPTY");

    writeFileSync(emptyFile, `${JSON.stringify({ entries: [null] })}\n`, "utf8");
    const invalidDisk = runner.replayFacilities({ computerBaseDir: emptyDir, tenantId: "t1" });
    expect(invalidDisk.passed).toBe(false);
    expect(invalidDisk.error).toBe("WAKE_LOG_MISMATCH");
  });

  it("replayWakeLog does not always return pass", () => {
    const src = readFileSync(path.join(process.cwd(), "src/habitat/wake-log.ts"), "utf8");
    expect(src).not.toMatch(/return \{ passed: true, kinds, runIds \}/);
    expect(src).toMatch(/WAKE_LOG_MISSING/);
    expect(src).toMatch(/WAKE_LOG_CORRUPT/);
    expect(src).toMatch(/WAKE_LOG_MISMATCH/);
    expect(src).toMatch(/WAKE_LOG_EMPTY/);
  });

  it("missing recordId and existing fail-closed paths stay fail-closed", async () => {
    const { core } = await habitatStack();
    expectPresentIdsDeniedWithoutRecord(core.facts, "t1");
    expect(() => core.records.get("t1", "")).toBeDefined();
    expect(core.records.has("t1", "rec_unknown")).toBe(false);
  });

  it("no pickAgent conductor in the field path", async () => {
    const fieldSrc = readFileSync(path.join(process.cwd(), "src/http/field-server.ts"), "utf8");
    expect(fieldSrc).not.toMatch(/pickAgent/);
    expect(fieldSrc).not.toMatch(/Follow-up/);
    expect(fieldSrc).toMatch(/boundPackAgent/);
    expect(fieldSrc).toMatch(/observeFieldStart/);
    expect(fieldSrc).toMatch(/wake\(\{ kind: "field_ask"/);
    expect(fieldSrc).toMatch(/\/field\/ask/);
    expect(fieldSrc).toMatch(/\/field\/kill/);
    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(
      /return this\.wake\(\{ \.\.\.event, kind: "field_start" \},\s*\{\s*holdWorker:\s*true\s*\}\);/,
    );
    expect(kernelSrc).not.toMatch(/wake\(\{ \.\.\.event, kind: "field_start" \},\s*\{\s*until:\s*["']talking["']/);
    expect(kernelSrc).not.toMatch(/does not throw ONE_GOAL/);
    expect(kernelSrc).toMatch(/throw new AvError\("ONE_GOAL"/);
    expect(kernelSrc).toMatch(/event\.kind === "field_ask"/);
    expect(kernelSrc).toMatch(/throw new AvError\("NO_OPEN_RUN"/);
  });

  it("follow-up sticks to the same worker; relaunch after kill is not follow-up", async () => {
    const { core, pack, tenantId, record } = await habitatStack();
    const first = core.habitat.wake({
      kind: "field_start",
      tenantId,
      pack,
      goal: "one goal",
      recordId: record.id,
    });
    const workerId = first.run!.workerId;
    const follow = core.habitat.wake({
      kind: "field_start",
      tenantId,
      pack,
      goal: "one goal",
      recordId: record.id,
    });
    expect(follow.run?.workerId).toBe(workerId);
    expect(follow.launchedWorker).toBe(false);
    core.habitat.wake({ kind: "kill", tenantId, reason: "relaunch" });
    const relaunch = core.habitat.wake({
      kind: "field_start",
      tenantId,
      pack,
      goal: "next goal",
      recordId: record.id,
    });
    expect(relaunch.run?.workerId).toBeDefined();
    expect(relaunch.run?.workerId).not.toBe(workerId);
    expect(relaunch.launchedWorker).toBe(true);
  });

  it("skill files are real files the worker can read", async () => {
    const { core, pack, tenantId, record, computerBaseDir } = await habitatStack();
    core.habitat.wake({
      kind: "field_start",
      tenantId,
      pack,
      goal: "one goal",
      recordId: record.id,
    });
    const skillsDir = computerRoot(computerBaseDir, tenantId).skillsDir;
    expect(existsSync(path.join(skillsDir, "dispatch.md"))).toBe(true);
    const worker = core.habitat.activeWorker(tenantId);
    expect(existsSync(path.join(worker!.trailerPath, "skills", "dispatch.md"))).toBe(true);
  });
});

describe("D10 §6 habitat disk memory", () => {
  it("persists profile, dated logs, and scoped recall across restart", async () => {
    const first = await habitatStack("mem");
    const agentId = first.agents[0]!.agentId;
    first.core.habitat.memory.writeProfile({
      tenantId: "mem",
      agentId,
      note: "owner prefers email",
    });
    first.core.habitat.memory.writeLog({
      tenantId: "mem",
      agentId,
      text: "dated log line",
      date: "2026-08-16",
    });
    first.core.habitat.memory.writeRecall({
      tenantId: "mem",
      scope: "agent",
      subjectId: agentId,
      text: "recall this later",
    });

    const second = new AlphaVectorCore(
      first.anchors,
      path.join(first.computerBaseDir, "state"),
      first.computerBaseDir,
    );
    expect(second.habitat.memory.loadProfile("mem", agentId)?.notes).toEqual(["owner prefers email"]);
    expect(second.habitat.memory.loadLogs("mem", agentId).map((e) => e.text)).toEqual(["dated log line"]);
    expect(second.habitat.memory.loadRecall("mem", "agent", agentId).map((e) => e.text)).toEqual([
      "recall this later",
    ]);
    const ephemeral = new MemoryTiers();
    ephemeral.write({ tenantId: "mem", tier: "agent", subjectId: agentId, text: "in-process only" });
    expect(ephemeral.list("mem")).toHaveLength(1);
    expect(second.habitat.memory.loadLogs("mem", agentId).some((e) => e.text === "in-process only")).toBe(
      false,
    );
  });

  it("kernel wake injects labeled memory, not an unlabeled blob", async () => {
    const { core, pack, tenantId, record, agents } = await habitatStack();
    const agentId = agents.find((a) => a.isOrchestrator)!.agentId;
    core.habitat.memory.writeProfile({ tenantId, agentId, note: "labeled profile" });
    const result = core.habitat.wake(
      { kind: "field_start", tenantId, pack, goal: "one goal", recordId: record.id },
      { until: "talking" },
    );
    expect(result.memory.profile.label).toBe("profile");
    expect(result.memory.logs.label).toBe("logs");
    expect(result.memory.recall.label).toBe("recall");
    expect(result.memory.profile.body?.notes).toContain("labeled profile");
    expect(JSON.stringify(result.memory)).not.toMatch(/listing_id|person_id|household_id|buyer_id/);
  });

  it("promoteToFact throws on habitat memory and in-process MemoryTiers", async () => {
    const { core, agents, tenantId } = await habitatStack();
    const agentId = agents[0]!.agentId;
    const log = core.habitat.memory.writeLog({ tenantId, agentId, text: "stay memory" });
    expect(() => core.habitat.memory.promoteToFact(log.logId)).toThrow(AvError);
    expect(() => core.habitat.memory.promoteToFact(log.logId)).toThrow(/SHALL NOT become verified facts/);
    const mem = new MemoryTiers();
    const entry = mem.write({ tenantId, tier: "agent", subjectId: agentId, text: "note" });
    expect(() => mem.promoteToFact(entry.memoryId)).toThrow(/SHALL NOT become verified facts/);
  });

  it("in-process MemoryTiers is not the habitat store", async () => {
    const first = await habitatStack("wipe");
    const agentId = first.agents[0]!.agentId;
    first.core.memory.write({
      tenantId: "wipe",
      tier: "agent",
      subjectId: agentId,
      text: "would vanish",
    });
    first.core.habitat.memory.writeProfile({
      tenantId: "wipe",
      agentId,
      note: "disk survives",
    });
    const second = new AlphaVectorCore(
      first.anchors,
      path.join(first.computerBaseDir, "state"),
      first.computerBaseDir,
    );
    expect(second.memory.list("wipe")).toEqual([]);
    expect(second.habitat.memory.loadProfile("wipe", agentId)?.notes).toEqual(["disk survives"]);
    const memorySrc = readFileSync(path.join(process.cwd(), "src/habitat/memory-store.ts"), "utf8");
    expect(memorySrc).not.toMatch(/neo4j|hindsight|holograph|vector db|HRR/i);
    expect(memorySrc).not.toMatch(/Mission-Control|Desk|Shape|Director|Play|Plant|HIL|Thor/);
  });
});

describe("D10 §6 field verbs", () => {
  it("field card approve resumes the habitat run; deny is terminal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-card-"));
    const { core, pack, field } = await liveField("t1", dir);
    const rec = core.records.put("t1", {
      type: pack.binding.recordPartyKnowledge.recordKinds[0] ?? "record",
      label: "Subject",
    });
    const started = core.habitat.wake({
      kind: "field_start",
      tenantId: "t1",
      pack,
      goal: "one goal",
      recordId: rec.id,
    });
    const approved = await field.approve(started.cardId!);
    expect(approved.card.status).toBe("approved");
    expect(approved.effect?.executed).toBe(true);
    expect(core.habitat.getRun("t1")?.runId).toBe(started.run?.runId);

    const again = await habitatStack("deny-http");
    const second = again.core.habitat.wake({
      kind: "field_start",
      tenantId: "deny-http",
      pack: again.pack,
      goal: "one goal",
      recordId: again.record.id,
    });
    again.core.cards.resolve({ cardId: second.cardId!, decision: "denied", actor: "field" });
    const denied = again.core.habitat.wake({
      kind: "card_decide",
      tenantId: "deny-http",
      pack: again.pack,
      cardId: second.cardId,
      decision: "denied",
    });
    expect(denied.run?.status).toBe("denied");
  });

  it("field kill tears the worker down", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-kill-"));
    const { core, field } = await liveField("t1", dir);
    await createOpenStart(field, "buyer", "Work this buyer journey");
    expect(core.habitat.trailerExists("t1")).toBe(true);
    await field.kill("stop");
    expect(core.habitat.trailerExists("t1")).toBe(false);
    expect(core.habitat.getRun("t1")?.status).toBe("killed");
  });

  it("POST field start creates runs.json, a run id, and labeled memory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-start-"));
    const { core, field } = await liveField("t1", dir);
    const orchId = core.agents.list("t1").find((a) => a.isOrchestrator)!.agentId;
    core.habitat.memory.writeProfile({ tenantId: "t1", agentId: orchId, note: "http-start-profile" });
    const { journey } = await createOpenStart(field, "buyer", "Work this buyer journey");
    const run = core.habitat.getRun("t1");
    expect(run?.runId).toMatch(/^run_/);
    expect(run?.goal).toBe(journey.objective);
    expect(existsSync(computerRoot(dir, "t1").runsFile)).toBe(true);
    const memory = core.habitat.memory.labeled("t1", orchId);
    expect(memory.profile.label).toBe("profile");
    expect(memory.logs.label).toBe("logs");
    expect(memory.recall.label).toBe("recall");
    expect(memory.profile.body?.notes).toContain("http-start-profile");
    expect(JSON.stringify(memory)).not.toMatch(/listing_id|person_id|household_id|buyer_id/);
  });

  it("POST field start launches the thin coder unless already awaiting a card for the same goal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-coder-"));
    const { core, field } = await liveField("t1", dir);
    const first = await createOpenStart(field, "buyer", "Work this buyer journey");
    const run = core.habitat.getRun("t1");
    expect(run?.talkingDidHeavyWork).toBe(false);
    expect(core.store.actions.filter((a) => a.status === "executed")).toHaveLength(0);
    expect(run?.status).toBe("awaiting_card");
    expect(run?.pendingCardId).toMatch(/^card_/);
    expect(core.habitat.trailerExists("t1")).toBe(true);
    expect(core.habitat.waitForExecutor("t1")).toBe(true);
    const worker = core.habitat.activeWorker("t1");
    expect(worker?.type).toBe("coder");
    expect(worker?.isolation).toBe("trailer");
    expect(worker?.pid).toBeDefined();
    expect(isPidAlive(worker?.pid)).toBe(true);
    expect(existsSync(path.join(worker!.trailerPath, ".branch"))).toBe(true);
    expect(readFileSync(path.join(worker!.trailerPath, ".branch"), "utf8")).toContain("coder/");
    const cards = await field.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.cardId).toBe(run!.pendingCardId);

    const follow = await field.start("buyer", first.journey.objective, first.record.id);
    expect(follow.id).toBeDefined();
    const again = core.habitat.getRun("t1");
    expect(again?.runId).toBe(run!.runId);
    expect(again?.workerId).toBe(run!.workerId);
    expect(core.habitat.activeWorker("t1")?.workerId).toBe(worker!.workerId);
    expect(core.habitat.activeWorker("t1")?.pid).toBe(worker!.pid);
    expect(isPidAlive(worker!.pid)).toBe(true);
    expect(core.habitat.trailerExists("t1")).toBe(true);
    expect(again?.talkingDidHeavyWork).toBe(false);
    expect(core.store.actions.filter((a) => a.status === "executed")).toHaveLength(0);
  });

  it("POST field start distinct goal B is rejected with ONE_GOAL and leaves only run A on disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-one-goal-"));
    const { core, field } = await liveField("t1", dir);
    const first = await createOpenStart(field, "buyer", "Work this buyer journey");
    const runA = core.habitat.getRun("t1");
    expect(runA?.runId).toMatch(/^run_/);
    expect(runA?.goal).toBe(first.journey.objective);
    expect(runA?.status).toBe("awaiting_card");

    const sellerRec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Seller subject",
    );
    await field.openApproved("seller", sellerRec.id);
    await expect(field.start("seller", "Work this seller journey", sellerRec.id)).rejects.toMatchObject({
      status: 400,
      code: "ONE_GOAL",
      message: expect.stringMatching(/one goal at a time/),
    });

    const still = core.habitat.getRun("t1");
    expect(still?.runId).toBe(runA!.runId);
    expect(still?.goal).toBe(first.journey.objective);
    expect(still?.status).toBe("awaiting_card");
    expect(still?.workerId).toBe(runA!.workerId);
    const onDisk = JSON.parse(readFileSync(computerRoot(dir, "t1").runsFile, "utf8")) as {
      runs: Array<{ runId: string; goal: string }>;
    };
    expect(onDisk.runs).toHaveLength(1);
    expect(onDisk.runs[0]?.runId).toBe(runA!.runId);
    expect(onDisk.runs[0]?.goal).toBe(first.journey.objective);
  });

  it("POST field start distinct goal B is allowed after the first run is terminal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-next-goal-"));
    const { core, field } = await liveField("t1", dir);
    await createOpenStart(field, "buyer", "Work this buyer journey");
    const runA = core.habitat.getRun("t1")!.runId;
    const workerA = core.habitat.getRun("t1")!.workerId;
    await field.kill("next goal");
    expect(core.habitat.getRun("t1")?.status).toBe("killed");

    const sellerRec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Seller subject",
    );
    await field.openApproved("seller", sellerRec.id);
    const seller = await field.start("seller", "Work this seller journey", sellerRec.id);
    expect(seller.journeyKind).toBe("seller");
    const runB = core.habitat.getRun("t1");
    expect(runB?.runId).toBeDefined();
    expect(runB?.runId).not.toBe(runA);
    expect(runB?.goal).toBe(seller.objective);
    expect(runB?.workerId).toBeDefined();
    expect(runB?.workerId).not.toBe(workerA);
    expect(runB?.status).toBe("awaiting_card");

    const approved = await field.approve(runB!.pendingCardId!);
    expect(approved.card.status).toBe("approved");
    expect(core.habitat.getRun("t1")?.status).toBe("completed");

    const listingRec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Listing subject",
    );
    await field.openApproved("listing", listingRec.id);
    const listing = await field.start("listing", "Work this listing journey", listingRec.id);
    expect(listing.journeyKind).toBe("listing");
    expect(core.habitat.getRun("t1")?.goal).toBe(listing.objective);
    expect(core.habitat.getRun("t1")?.runId).not.toBe(runB!.runId);

    await field.deny(core.habitat.getRun("t1")!.pendingCardId!);
    expect(core.habitat.getRun("t1")?.status).toBe("denied");
    const again = await field.start("listing", "Work this listing journey", listingRec.id);
    expect(again.journeyKind).toBe("listing");
    expect(core.habitat.getRun("t1")?.status).toBe("awaiting_card");
    expect(core.habitat.getRun("t1")?.goal).toBe(again.objective);
  });

  it("approve via field card resumes the same run id from HTTP start", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-approve-"));
    const { core, field } = await liveField("t1", dir);
    await createOpenStart(field, "buyer", "Work this buyer journey");
    const runId = core.habitat.getRun("t1")!.runId;
    const cardId = core.habitat.getRun("t1")!.pendingCardId!;
    const approved = await field.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.effect?.executed).toBe(true);
    expect(approved.runId).toBe(runId);
    expect(core.habitat.getRun("t1")?.runId).toBe(runId);
    expect(core.habitat.getRun("t1")?.status).toBe("completed");
  });

  it("kill via field after HTTP start tears the trailer down", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-kill-"));
    const { core, field } = await liveField("t1", dir);
    await createOpenStart(field, "buyer", "Work this buyer journey");
    expect(core.habitat.trailerExists("t1")).toBe(true);
    await field.kill("stop");
    expect(core.habitat.trailerExists("t1")).toBe(false);
    expect(core.habitat.activeWorker("t1")).toBeUndefined();
    expect(core.habitat.getRun("t1")?.status).toBe("killed");
  });

  it("restart on the same computerBaseDir still sees the HTTP-started run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-restart-"));
    const first = await liveField("t1", dir);
    await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const runId = first.core.habitat.getRun("t1")!.runId;
    const cardId = first.core.habitat.getRun("t1")!.pendingCardId!;

    const second = new AlphaVectorCore(makeAnchors().anchors, path.join(dir, "state"), dir);
    expect(second.habitat.getRun("t1")?.runId).toBe(runId);
    expect(second.habitat.getRun("t1")?.pendingCardId).toBe(cardId);
    expect(second.habitat.getRun("t1")?.status).toBe("awaiting_card");
  });

  it("HTTP start, process restart, leftover trailer dir, same-goal field start relaunches the same workerId", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-leftover-dir-"));
    const first = await liveField("t1", dir);
    const started = await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const run = first.core.habitat.getRun("t1")!;
    const worker = first.core.habitat.activeWorker("t1")!;
    expect(worker.workerId).toBe(run.workerId);
    expect(worker.type).toBe("coder");
    expect(existsSync(worker.trailerPath)).toBe(true);
    expect(isPidAlive(worker.pid)).toBe(true);
    killPidLeaveBook(worker.pid);
    const paths = computerRoot(dir, "t1");
    expect(existsSync(paths.workersFile)).toBe(true);
    expect(paths.workersFile).toBe(path.join(dir, "tenants", "t1", "workers.json"));
    expect(existsSync(path.join(paths.disk, "workers.json"))).toBe(false);
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    const again = second.core.habitat.getRun("t1");
    const booked = second.core.habitat.activeWorker("t1");
    expect(again?.runId).toBe(run.runId);
    expect(again?.workerId).toBe(worker.workerId);
    expect(booked?.workerId).toBe(worker.workerId);
    expect(booked?.trailerPath).toBe(worker.trailerPath);
    expect(booked?.branch).toBe(worker.branch);
    expect(existsSync(worker.trailerPath)).toBe(true);
    expect(second.core.habitat.trailerExists("t1")).toBe(true);
    expect(isPidAlive(booked?.pid)).toBe(false);

    const follow = await second.field.start("buyer", started.journey.objective, started.record.id);
    expect(follow.id).toBeDefined();
    const live = second.core.habitat.activeWorker("t1");
    expect(second.core.habitat.getRun("t1")?.runId).toBe(run.runId);
    expect(second.core.habitat.getRun("t1")?.workerId).toBe(worker.workerId);
    expect(live?.workerId).toBe(worker.workerId);
    expect(live?.trailerPath).toBe(worker.trailerPath);
    expect(live?.branch).toBe(worker.branch);
    expect(live?.pid).toBeDefined();
    expect(live?.pid).not.toBe(worker.pid);
    expect(isPidAlive(live?.pid)).toBe(true);
    expect(second.core.habitat.trailerExists("t1")).toBe(true);
  });

  it("live pid: same-goal field start does not relaunch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-live-pid-"));
    const first = await liveField("t1", dir);
    const started = await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const run = first.core.habitat.getRun("t1")!;
    const worker = first.core.habitat.activeWorker("t1")!;
    expect(existsSync(worker.trailerPath)).toBe(true);
    expect(isPidAlive(worker.pid)).toBe(true);
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    expect(second.core.habitat.activeWorker("t1")?.pid).toBe(worker.pid);
    expect(isPidAlive(second.core.habitat.activeWorker("t1")?.pid)).toBe(true);

    await second.field.start("buyer", started.journey.objective, started.record.id);
    expect(second.core.habitat.getRun("t1")?.runId).toBe(run.runId);
    expect(second.core.habitat.getRun("t1")?.workerId).toBe(worker.workerId);
    expect(second.core.habitat.activeWorker("t1")?.workerId).toBe(worker.workerId);
    expect(second.core.habitat.activeWorker("t1")?.pid).toBe(worker.pid);
    expect(isPidAlive(second.core.habitat.activeWorker("t1")?.pid)).toBe(true);

    await second.field.kill("stop");
    expect(second.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(isPidAlive(worker.pid)).toBe(false);
  });

  it("field kill after dead-pid relaunch tears the trailer down and clears the book", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-dead-pid-kill-"));
    const first = await liveField("t1", dir);
    const started = await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const worker = first.core.habitat.activeWorker("t1")!;
    expect(existsSync(worker.trailerPath)).toBe(true);
    expect(isPidAlive(worker.pid)).toBe(true);
    killPidLeaveBook(worker.pid);
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    await second.field.start("buyer", started.journey.objective, started.record.id);
    const live = second.core.habitat.activeWorker("t1");
    expect(live?.workerId).toBe(worker.workerId);
    expect(live?.pid).not.toBe(worker.pid);
    expect(isPidAlive(live?.pid)).toBe(true);
    expect(second.core.habitat.trailerExists("t1")).toBe(true);
    await second.field.kill("stop");
    expect(second.core.habitat.trailerExists("t1")).toBe(false);
    expect(second.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(existsSync(worker.trailerPath)).toBe(false);
    expect(second.core.habitat.getRun("t1")?.status).toBe("killed");
    await second.server.close();

    const third = await liveField("t1", dir, { field: first.fieldToken });
    expect(third.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(third.core.habitat.trailerExists("t1")).toBe(false);
  });

  it("field kill after HTTP start and restart tears the trailer down and the book is empty on a third core", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-kill-restart-"));
    const first = await liveField("t1", dir);
    await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const worker = first.core.habitat.activeWorker("t1")!;
    expect(existsSync(worker.trailerPath)).toBe(true);
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    expect(second.core.habitat.activeWorker("t1")?.workerId).toBe(worker.workerId);
    await second.field.kill("stop");
    expect(second.core.habitat.trailerExists("t1")).toBe(false);
    expect(second.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(existsSync(worker.trailerPath)).toBe(false);
    expect(second.core.habitat.getRun("t1")?.status).toBe("killed");
    await second.server.close();

    const third = await liveField("t1", dir, { field: first.fieldToken });
    expect(third.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(third.core.habitat.trailerExists("t1")).toBe(false);
    expect(existsSync(worker.trailerPath)).toBe(false);
  });

  it("field approve after HTTP start and restart completes the same run and clears the book", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-approve-restart-"));
    const first = await liveField("t1", dir);
    await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const runId = first.core.habitat.getRun("t1")!.runId;
    const cardId = first.core.habitat.getRun("t1")!.pendingCardId!;
    const workerId = first.core.habitat.activeWorker("t1")!.workerId;
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    expect(second.core.habitat.activeWorker("t1")?.workerId).toBe(workerId);
    const approved = await second.field.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.effect?.executed).toBe(true);
    expect(approved.runId).toBe(runId);
    expect(second.core.habitat.getRun("t1")?.runId).toBe(runId);
    expect(second.core.habitat.getRun("t1")?.status).toBe("completed");
    expect(second.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(second.core.habitat.trailerExists("t1")).toBe(false);
  });

  it("field deny after HTTP start and restart is terminal and clears the book", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-deny-restart-"));
    const first = await liveField("t1", dir);
    await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const runId = first.core.habitat.getRun("t1")!.runId;
    const cardId = first.core.habitat.getRun("t1")!.pendingCardId!;
    const workerId = first.core.habitat.activeWorker("t1")!.workerId;
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    expect(second.core.habitat.activeWorker("t1")?.workerId).toBe(workerId);
    const denied = await second.field.deny(cardId);
    expect(denied.status).toBe("denied");
    expect(second.core.habitat.getRun("t1")?.runId).toBe(runId);
    expect(second.core.habitat.getRun("t1")?.status).toBe("denied");
    expect(second.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(second.core.habitat.trailerExists("t1")).toBe(false);
  });

  it("HTTP start, process restart, same-goal field start relaunches the same workerId when the trailer is gone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-relaunch-"));
    const first = await liveField("t1", dir);
    const started = await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const run = first.core.habitat.getRun("t1")!;
    const worker = first.core.habitat.activeWorker("t1")!;
    const cardId = run.pendingCardId;
    expect(run.status).toBe("awaiting_card");
    expect(existsSync(worker.trailerPath)).toBe(true);
    expect(isPidAlive(worker.pid)).toBe(true);
    killPidLeaveBook(worker.pid);
    rmSync(worker.trailerPath, { recursive: true, force: true });
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    expect(second.core.habitat.getRun("t1")?.runId).toBe(run.runId);
    expect(second.core.habitat.getRun("t1")?.status).toBe("awaiting_card");
    expect(second.core.habitat.activeWorker("t1")?.workerId).toBe(worker.workerId);
    expect(second.core.habitat.trailerExists("t1")).toBe(false);

    await second.field.start("buyer", started.journey.objective, started.record.id);
    const live = second.core.habitat.activeWorker("t1");
    expect(second.core.habitat.getRun("t1")?.runId).toBe(run.runId);
    expect(second.core.habitat.getRun("t1")?.workerId).toBe(worker.workerId);
    expect(second.core.habitat.getRun("t1")?.pendingCardId).toBe(cardId);
    expect(live?.workerId).toBe(worker.workerId);
    expect(live?.branch).toBe(worker.branch);
    expect(live?.trailerPath).toBe(worker.trailerPath);
    expect(second.core.habitat.trailerExists("t1")).toBe(true);
    expect(existsSync(worker.trailerPath)).toBe(true);
    expect(second.core.habitat.waitForExecutor("t1")).toBe(true);

    const book = new WorkerBook(dir);
    expect(book.get("t1")?.workerId).toBe(worker.workerId);
    expect(book.launch({ tenantId: "t1", runId: worker.runId }).workerId).toBe(worker.workerId);
    expect(book.get("t1")?.workerId).toBe(worker.workerId);
  });

  it("same-goal follow-up after that relaunch still sticks to the same workerId", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-relaunch-stick-"));
    const first = await liveField("t1", dir);
    const started = await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const run = first.core.habitat.getRun("t1")!;
    const worker = first.core.habitat.activeWorker("t1")!;
    expect(isPidAlive(worker.pid)).toBe(true);
    killPidLeaveBook(worker.pid);
    rmSync(worker.trailerPath, { recursive: true, force: true });
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    await second.field.start("buyer", started.journey.objective, started.record.id);
    expect(second.core.habitat.activeWorker("t1")?.workerId).toBe(worker.workerId);
    expect(second.core.habitat.trailerExists("t1")).toBe(true);

    const follow = await second.field.start("buyer", started.journey.objective, started.record.id);
    expect(follow.id).toBeDefined();
    expect(second.core.habitat.getRun("t1")?.runId).toBe(run.runId);
    expect(second.core.habitat.getRun("t1")?.workerId).toBe(worker.workerId);
    expect(second.core.habitat.activeWorker("t1")?.workerId).toBe(worker.workerId);
    expect(second.core.habitat.activeWorker("t1")?.branch).toBe(worker.branch);
    expect(second.core.habitat.trailerExists("t1")).toBe(true);
  });

  it("field kill after same-id relaunch tears the trailer down and clears the book", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-relaunch-kill-"));
    const first = await liveField("t1", dir);
    const started = await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const worker = first.core.habitat.activeWorker("t1")!;
    expect(isPidAlive(worker.pid)).toBe(true);
    killPidLeaveBook(worker.pid);
    rmSync(worker.trailerPath, { recursive: true, force: true });
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    await second.field.start("buyer", started.journey.objective, started.record.id);
    expect(second.core.habitat.activeWorker("t1")?.workerId).toBe(worker.workerId);
    expect(second.core.habitat.trailerExists("t1")).toBe(true);
    await second.field.kill("stop");
    expect(second.core.habitat.trailerExists("t1")).toBe(false);
    expect(second.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(existsSync(worker.trailerPath)).toBe(false);
    expect(second.core.habitat.getRun("t1")?.status).toBe("killed");
    await second.server.close();

    const third = await liveField("t1", dir, { field: first.fieldToken });
    expect(third.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(third.core.habitat.trailerExists("t1")).toBe(false);
  });

  it("field approve after same-id relaunch completes the same run and clears the book", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-relaunch-approve-"));
    const first = await liveField("t1", dir);
    const started = await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const runId = first.core.habitat.getRun("t1")!.runId;
    const cardId = first.core.habitat.getRun("t1")!.pendingCardId!;
    const worker = first.core.habitat.activeWorker("t1")!;
    expect(isPidAlive(worker.pid)).toBe(true);
    killPidLeaveBook(worker.pid);
    rmSync(worker.trailerPath, { recursive: true, force: true });
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    await second.field.start("buyer", started.journey.objective, started.record.id);
    expect(second.core.habitat.activeWorker("t1")?.workerId).toBe(worker.workerId);
    expect(second.core.habitat.getRun("t1")?.pendingCardId).toBe(cardId);
    const approved = await second.field.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.effect?.executed).toBe(true);
    expect(approved.runId).toBe(runId);
    expect(second.core.habitat.getRun("t1")?.runId).toBe(runId);
    expect(second.core.habitat.getRun("t1")?.status).toBe("completed");
    expect(second.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(second.core.habitat.trailerExists("t1")).toBe(false);
  });

  it("field deny after same-id relaunch is terminal and clears the book", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-relaunch-deny-"));
    const first = await liveField("t1", dir);
    const started = await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const runId = first.core.habitat.getRun("t1")!.runId;
    const cardId = first.core.habitat.getRun("t1")!.pendingCardId!;
    const worker = first.core.habitat.activeWorker("t1")!;
    expect(isPidAlive(worker.pid)).toBe(true);
    killPidLeaveBook(worker.pid);
    rmSync(worker.trailerPath, { recursive: true, force: true });
    await first.server.close();

    const second = await liveField("t1", dir, { field: first.fieldToken });
    await second.field.start("buyer", started.journey.objective, started.record.id);
    expect(second.core.habitat.activeWorker("t1")?.workerId).toBe(worker.workerId);
    const denied = await second.field.deny(cardId);
    expect(denied.status).toBe("denied");
    expect(second.core.habitat.getRun("t1")?.runId).toBe(runId);
    expect(second.core.habitat.getRun("t1")?.status).toBe("denied");
    expect(second.core.habitat.activeWorker("t1")).toBeUndefined();
    expect(second.core.habitat.trailerExists("t1")).toBe(false);
  });

  it("corrupt workers.json still WORKER_STORE_CORRUPT", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-workers-corrupt-"));
    const first = await liveField("t1", dir);
    const started = await createOpenStart(first.field, "buyer", "Work this buyer journey");
    const workerId = first.core.habitat.activeWorker("t1")!.workerId;
    await first.server.close();
    writeFileSync(computerRoot(dir, "t1").workersFile, "{not-json", "utf8");

    const second = await liveField("t1", dir, { field: first.fieldToken });
    await expect(
      second.field.start("buyer", started.journey.objective, started.record.id),
    ).rejects.toMatchObject({
      status: 500,
      code: "WORKER_STORE_CORRUPT",
    });
    expect(second.core.habitat.getRun("t1")?.workerId).toBe(workerId);

    const book = new WorkerBook(dir);
    expect(() => book.get("t1")).toThrow(AvError);
    expect(() => book.get("t1")).toThrow(/WORKER_STORE_CORRUPT|corrupt/i);
    expect(() => book.launch({ tenantId: "t1", runId: "run_invented" })).toThrow(AvError);
    expect(() => book.launch({ tenantId: "t1", runId: "run_invented" })).toThrow(/corrupt/i);
    expect(() => book.getById("t1", "worker_invented")).toThrow(/corrupt/i);
  });

  it("HTTP start, then field ask attaches to the same run with field_ask wake and labeled memory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-ask-"));
    const { core, field } = await liveField("t1", dir);
    const orchId = core.agents.list("t1").find((a) => a.isOrchestrator)!.agentId;
    core.habitat.memory.writeProfile({ tenantId: "t1", agentId: orchId, note: "ask-profile" });
    const started = await createOpenStart(field, "buyer", "Work this buyer journey");
    const run = core.habitat.getRun("t1");
    expect(run?.runId).toMatch(/^run_/);
    const worker = core.habitat.activeWorker("t1");
    expect(worker?.workerId).toBeDefined();
    expect(core.habitat.trailerExists("t1")).toBe(true);
    const trailerPath = worker!.trailerPath;
    const workerId = worker!.workerId;
    const pid = worker!.pid;

    const asked = await field.ask("status?", "read");
    expect(asked.ok).toBe(true);
    expect(asked.runId).toBe(run!.runId);
    expect(asked.memory.profile.label).toBe("profile");
    expect(asked.memory.logs.label).toBe("logs");
    expect(asked.memory.recall.label).toBe("recall");
    expect(asked.memory.profile.body).toEqual(
      expect.objectContaining({ notes: expect.arrayContaining(["ask-profile"]) }),
    );

    const after = core.habitat.getRun("t1");
    expect(after?.runId).toBe(run!.runId);
    expect(after?.goal).toBe(started.journey.objective);
    expect(after?.status).toBe(run!.status);
    expect(after?.workerId).toBe(workerId);
    expect(after?.talkingDidHeavyWork).toBe(false);
    const onDisk = JSON.parse(readFileSync(computerRoot(dir, "t1").runsFile, "utf8")) as {
      runs: Array<{ runId: string; goal: string }>;
    };
    expect(onDisk.runs).toHaveLength(1);
    expect(onDisk.runs[0]?.runId).toBe(run!.runId);

    const wakes = core.habitat.listWakes("t1");
    expect(wakes.some((w) => w.kind === "field_start" && w.runId === run!.runId)).toBe(true);
    expect(wakes.some((w) => w.kind === "field_ask" && w.runId === run!.runId)).toBe(true);
    expect(wakes.filter((w) => w.kind === "field_ask")).toHaveLength(1);

    const still = core.habitat.activeWorker("t1");
    expect(still?.workerId).toBe(workerId);
    expect(still?.trailerPath).toBe(trailerPath);
    expect(still?.pid).toBe(pid);
    expect(isPidAlive(pid)).toBe(true);
    expect(core.habitat.trailerExists("t1")).toBe(true);
    expect(core.store.actions.filter((a) => a.status === "executed")).toHaveLength(0);
  });

  it("field ask with no open run is NO_OPEN_RUN and does not create runs.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-ask-no-run-"));
    const { core, field } = await liveField("t1", dir);
    expect(existsSync(computerRoot(dir, "t1").runsFile)).toBe(false);
    await expect(field.ask("status?", "read")).rejects.toMatchObject({
      status: 400,
      code: "NO_OPEN_RUN",
      message: expect.stringMatching(/no implicit start/i),
    });
    expect(existsSync(computerRoot(dir, "t1").runsFile)).toBe(false);
    expect(core.habitat.getRun("t1")).toBeUndefined();
    expect(core.habitat.listWakes("t1")).toEqual([]);
    expect(core.habitat.trailerExists("t1")).toBe(false);
  });

  it("after field ask, a different-goal field start is still ONE_GOAL", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-http-ask-one-goal-"));
    const { core, field } = await liveField("t1", dir);
    const first = await createOpenStart(field, "buyer", "Work this buyer journey");
    const runA = core.habitat.getRun("t1");
    const asked = await field.ask("status?", "read");
    expect(asked.runId).toBe(runA!.runId);

    const sellerRec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Seller subject",
    );
    await field.openApproved("seller", sellerRec.id);
    await expect(field.start("seller", "Work this seller journey", sellerRec.id)).rejects.toMatchObject({
      status: 400,
      code: "ONE_GOAL",
      message: expect.stringMatching(/one goal at a time/),
    });

    const still = core.habitat.getRun("t1");
    expect(still?.runId).toBe(runA!.runId);
    expect(still?.goal).toBe(first.journey.objective);
    expect(still?.status).toBe("awaiting_card");
    const onDisk = JSON.parse(readFileSync(computerRoot(dir, "t1").runsFile, "utf8")) as {
      runs: Array<{ runId: string; goal: string }>;
    };
    expect(onDisk.runs).toHaveLength(1);
    expect(onDisk.runs[0]?.runId).toBe(runA!.runId);
    expect(onDisk.runs[0]?.goal).toBe(first.journey.objective);
  });
});

describe("D10 HK-055–HK-059 real think / Architect bind", () => {
  it("keeps the RE fixture pin at 5091328", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
  });

  it("product boot defaults to DeepAgentsAdapter; DryStem is fixture-only", () => {
    const bootSrc = readFileSync(path.join(process.cwd(), "src/http/field-boot.ts"), "utf8");
    expect(bootSrc).toMatch(/opts\.adapter \?\? new DeepAgentsAdapter/);
    expect(bootSrc).not.toMatch(/new DryStemAdapter/);
    const listenSrc = readFileSync(path.join(process.cwd(), "src/http/field-listen.ts"), "utf8");
    expect(listenSrc).not.toMatch(/DryStemAdapter/);
    expect(listenSrc).toMatch(/bootFieldCore\(tenantId, \{ computerBaseDir: opts\.computerBaseDir \}\)/);
    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(/opts\.adapter \?\? new DeepAgentsAdapter/);
    expect(kernelSrc).not.toMatch(/new DryStemAdapter/);
    expect(kernelSrc).toMatch(
      /return this\.wake\(\{ \.\.\.event, kind: "field_start" \},\s*\{\s*holdWorker:\s*true\s*\}\);/,
    );
    const workerSrc = readFileSync(path.join(process.cwd(), "src/habitat/worker.ts"), "utf8");
    expect(workerSrc).not.toMatch(/detached:\s*true/);
    expect(workerSrc).not.toMatch(/\.unref\s*\(/);
    const coreSrc = readFileSync(path.join(process.cwd(), "src/kernel.ts"), "utf8");
    expect(coreSrc).toMatch(/opts\?\.adapter \?\? new DeepAgentsAdapter/);
    expect(coreSrc).not.toMatch(/DryStemAdapter/);
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
  });

  it("bound-model wake invokes the adapter think path without the field user setting a model", async () => {
    const stack = await habitatThinkStack();
    architectBindAdapter({
      tenantId: stack.tenantId,
      modelId: "ci-double",
      computerBaseDir: stack.computerBaseDir,
      architectToken: stack.architectToken,
    });
    const paths = computerRoot(stack.computerBaseDir, stack.tenantId);
    expect(paths.adapterBindFile).toBe(
      path.join(stack.computerBaseDir, "tenants", stack.tenantId, "adapter-bind.json"),
    );
    expect(existsSync(paths.adapterBindFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "adapter-bind.json"))).toBe(false);
    const raw = readFileSync(paths.adapterBindFile, "utf8");
    expect(raw).toMatch(/"modelId": "ci-double"/);
    expect(raw).toMatch(/"boundBy": "architect"/);
    expect(raw).not.toMatch(/apiKey|secret|credential|password/);

    expect(DeepAgentsAdapter.invocations).toBe(0);
    const talking = stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { until: "talking" },
    );
    expect(DeepAgentsAdapter.invocations).toBe(1);
    expect(DeepAgentsAdapter.lastModelId).toBe("ci-double");
    expect(talking.launchedWorker).toBe(false);
    expect(talking.talkingDidHeavyWork).toBe(false);
    expect(talking.run?.status).toBe("talking");
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(false);

    const working = stack.core.habitat.wake({
      kind: "field_start",
      tenantId: stack.tenantId,
      pack: stack.pack,
      goal: "one goal",
      recordId: stack.record.id,
    });
    expect(DeepAgentsAdapter.invocations).toBeGreaterThanOrEqual(2);
    expect(DeepAgentsAdapter.lastModelId).toBe("ci-double");
    expect(working.launchedWorker).toBe(true);
    expect(working.run?.workerType).toBe("coder");
    expect(working.cardId).toMatch(/^card_/);
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(true);
    expect(working.talkingDidHeavyWork).toBe(false);

    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).not.toMatch(/createDeepAgent\s*\(/);
    const adapterSrc = readFileSync(path.join(process.cwd(), "src/habitat/deep-agents.ts"), "utf8");
    expect(adapterSrc).not.toMatch(/dryThink/);
    expect(adapterSrc).not.toMatch(/createDeepAgent\s*\(/);
    expect(adapterSrc).toMatch(/adapterThink/);
  });

  it("unbound wake is ADAPTER_UNBOUND with no think, worker, or dry-stem stamp", async () => {
    const stack = await habitatThinkStack();
    const paths = computerRoot(stack.computerBaseDir, stack.tenantId);
    expect(existsSync(paths.adapterBindFile)).toBe(false);
    expect(DeepAgentsAdapter.invocations).toBe(0);
    expect(() =>
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      }),
    ).toThrow(AvError);
    try {
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      });
      expect.fail("unbound wake must fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(AvError);
      expect(err).toMatchObject({
        code: "ADAPTER_UNBOUND",
        closed: true,
        message: expect.stringMatching(/no silent default/i),
      });
    }
    expect(DeepAgentsAdapter.invocations).toBe(0);
    expect(DeepAgentsAdapter.lastModelId).toBeUndefined();
    expect(stack.core.habitat.getRun(stack.tenantId)).toBeUndefined();
    expect(existsSync(paths.runsFile)).toBe(false);
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(false);
    expect(stack.core.habitat.listWakes(stack.tenantId)).toEqual([]);
  });

  it("pack defaultModelId is not live until Architect writes the bind", async () => {
    const stack = await habitatThinkStack("t1", (unsigned) => {
      unsigned.adapter = { defaultModelId: "ci-double", allowList: ["ci-double"] };
    });
    expect(() =>
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      }),
    ).toThrow(/ADAPTER_UNBOUND|no silent default/);
    expect(DeepAgentsAdapter.invocations).toBe(0);
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(false);
    expect(stack.core.habitat.getRun(stack.tenantId)).toBeUndefined();
  });

  it("bind outside pack allow-list is ADAPTER_NOT_ALLOWED", async () => {
    const stack = await habitatThinkStack("t1", (unsigned) => {
      unsigned.adapter = { allowList: ["ci-double"], defaultModelId: "ci-double" };
    });
    architectBindAdapter({
      tenantId: stack.tenantId,
      modelId: "other-model",
      computerBaseDir: stack.computerBaseDir,
      architectToken: stack.architectToken,
    });
    expect(() =>
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      }),
    ).toThrow(AvError);
    try {
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      });
      expect.fail("bind outside allow-list must fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(AvError);
      expect(err).toMatchObject({
        code: "ADAPTER_NOT_ALLOWED",
        closed: true,
      });
    }
    expect(DeepAgentsAdapter.invocations).toBe(0);
    expect(stack.core.habitat.getRun(stack.tenantId)).toBeUndefined();
    expect(stack.core.habitat.trailerExists(stack.tenantId)).toBe(false);
  });

  it("bootFieldCore with no adapter option and Architect bind invokes DeepAgentsAdapter think", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-think-http-bound-"));
    const { core, field, architectToken } = await liveProductField("t1", dir);
    expect(architectToken).toBeDefined();
    architectBindAdapter({
      tenantId: "t1",
      modelId: "ci-double",
      computerBaseDir: dir,
      architectToken: architectToken!,
    });
    expect(DeepAgentsAdapter.invocations).toBe(0);
    const home = await field.home();
    expect(JSON.stringify(home)).not.toMatch(/adapter-bind|modelId|allowList|ci-double|pickAgent/);
    await createOpenStart(field, "buyer", "Work this buyer journey");
    expect(DeepAgentsAdapter.invocations).toBeGreaterThan(0);
    expect(DeepAgentsAdapter.lastModelId).toBe("ci-double");
    expect(core.habitat.getRun("t1")?.runId).toMatch(/^run_/);
    expect(core.habitat.trailerExists("t1")).toBe(true);
    expect(core.habitat.getRun("t1")?.talkingDidHeavyWork).toBe(false);
    const worker = core.habitat.activeWorker("t1");
    expect(worker?.pid).toBeDefined();
    expect(isPidAlive(worker?.pid)).toBe(true);
    expect(new WorkerBook(dir).isLive("t1")).toBe(true);
    const booked = JSON.parse(readFileSync(computerRoot(dir, "t1").workersFile, "utf8")) as {
      workers: Array<{ pid?: number; workerId: string }>;
    };
    expect(booked.workers[0]?.pid).toBe(worker?.pid);
    expect(core.habitat.getRun("t1")?.status).toBe("awaiting_card");
    expect(core.habitat.getRun("t1")?.pendingCardId).toMatch(/^card_/);
  });

  it("HTTP start on a bound tenant holds a live coder pid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-think-http-hold-"));
    const { core, field, architectToken } = await liveProductField("t1", dir);
    architectBindAdapter({
      tenantId: "t1",
      modelId: "ci-double",
      computerBaseDir: dir,
      architectToken: architectToken!,
    });
    await createOpenStart(field, "buyer", "Work this buyer journey");
    const worker = core.habitat.activeWorker("t1");
    expect(worker?.pid).toBeDefined();
    expect(isPidAlive(worker?.pid)).toBe(true);
    expect(new WorkerBook(dir).isLive("t1")).toBe(true);
    expect(existsSync(computerRoot(dir, "t1").workersFile)).toBe(true);
    const booked = JSON.parse(readFileSync(computerRoot(dir, "t1").workersFile, "utf8")) as {
      workers: Array<{ pid?: number }>;
    };
    expect(booked.workers[0]?.pid).toBe(worker?.pid);
    expect(core.habitat.trailerExists("t1")).toBe(true);
    expect(core.habitat.getRun("t1")?.talkingDidHeavyWork).toBe(false);
    expect(core.habitat.getRun("t1")?.status).toBe("awaiting_card");
    expect(core.habitat.getRun("t1")?.pendingCardId).toMatch(/^card_/);
    const cards = await field.cards();
    expect(cards).toHaveLength(1);
    expect(DeepAgentsAdapter.invocations).toBeGreaterThan(0);
  });

  it("same-goal second HTTP start returns the existing worker and does not relaunch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-think-http-follow-"));
    const { core, field, architectToken, pack } = await liveProductField("t1", dir);
    architectBindAdapter({
      tenantId: "t1",
      modelId: "ci-double",
      computerBaseDir: dir,
      architectToken: architectToken!,
    });
    const started = await createOpenStart(field, "buyer", "Work this buyer journey");
    const worker = core.habitat.activeWorker("t1")!;
    expect(isPidAlive(worker.pid)).toBe(true);
    const follow = await field.start("buyer", started.journey.objective, started.record.id);
    expect(follow.id).toBeDefined();
    expect(core.habitat.getRun("t1")?.runId).toBeDefined();
    expect(core.habitat.getRun("t1")?.workerId).toBe(worker.workerId);
    expect(core.habitat.activeWorker("t1")?.workerId).toBe(worker.workerId);
    expect(core.habitat.activeWorker("t1")?.pid).toBe(worker.pid);
    expect(isPidAlive(worker.pid)).toBe(true);
    const kernelFollow = core.habitat.observeFieldStart({
      tenantId: "t1",
      pack,
      goal: started.journey.objective,
      journeyId: follow.id,
      recordId: started.record.id,
    });
    expect(kernelFollow.launchedWorker).toBe(false);
    expect(kernelFollow.run?.workerId).toBe(worker.workerId);
    expect(core.habitat.activeWorker("t1")?.pid).toBe(worker.pid);
  });

  it("HTTP kill after a held start tears the trailer down and clears the book", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-think-http-hold-kill-"));
    const { core, field, architectToken } = await liveProductField("t1", dir);
    architectBindAdapter({
      tenantId: "t1",
      modelId: "ci-double",
      computerBaseDir: dir,
      architectToken: architectToken!,
    });
    await createOpenStart(field, "buyer", "Work this buyer journey");
    const worker = core.habitat.activeWorker("t1")!;
    expect(isPidAlive(worker.pid)).toBe(true);
    expect(core.habitat.trailerExists("t1")).toBe(true);
    await field.kill("stop");
    expect(core.habitat.trailerExists("t1")).toBe(false);
    expect(core.habitat.activeWorker("t1")).toBeUndefined();
    expect(isPidAlive(worker.pid)).toBe(false);
    expect(new WorkerBook(dir).get("t1")).toBeUndefined();
    expect(new WorkerBook(dir).isLive("t1")).toBe(false);
    expect(core.habitat.getRun("t1")?.status).toBe("killed");
  });

  it("bootFieldCore with no adapter option and no bind is ADAPTER_UNBOUND", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-think-http-unbound-"));
    const { core, field } = await liveProductField("t1", dir);
    const rec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Subject",
    );
    await field.openApproved("buyer", rec.id);
    await expect(field.start("buyer", "Work this buyer journey", rec.id)).rejects.toMatchObject({
      status: 400,
      code: "ADAPTER_UNBOUND",
    });
    expect(DeepAgentsAdapter.invocations).toBe(0);
    expect(existsSync(computerRoot(dir, "t1").runsFile)).toBe(false);
    expect(existsSync(computerRoot(dir, "t1").workersFile)).toBe(false);
    expect(core.habitat.getRun("t1")).toBeUndefined();
    expect(core.habitat.activeWorker("t1")).toBeUndefined();
    expect(core.habitat.trailerExists("t1")).toBe(false);
  });

  it("field-serve with no adapter option and Architect bind invokes DeepAgentsAdapter think", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-think-serve-bound-"));
    const architect = architectIssueFieldToken({
      tenantId: "t1",
      principal: "architect",
      computerBaseDir: dir,
    });
    const issued = architectIssueFieldToken({
      tenantId: "t1",
      principal: "field",
      computerBaseDir: dir,
      architectToken: architect.token,
    });
    architectBindAdapter({
      tenantId: "t1",
      modelId: "ci-double",
      computerBaseDir: dir,
      architectToken: architect.token,
    });
    const started = await startFieldServe({ tenantId: "t1", computerBaseDir: dir, port: 0 });
    servers.push(started.server);
    const field = new FieldClient(started.url, issued.token);
    expect(DeepAgentsAdapter.invocations).toBe(0);
    const home = await field.home();
    expect(JSON.stringify(home)).not.toMatch(/adapter-bind|modelId|allowList|ci-double|pickAgent/);
    await createOpenStart(field, "buyer", "Work this buyer journey");
    expect(DeepAgentsAdapter.invocations).toBeGreaterThan(0);
    expect(DeepAgentsAdapter.lastModelId).toBe("ci-double");
    expect(existsSync(computerRoot(dir, "t1").runsFile)).toBe(true);
    expect(existsSync(computerRoot(dir, "t1").workersFile)).toBe(true);
    const onDisk = JSON.parse(readFileSync(computerRoot(dir, "t1").runsFile, "utf8")) as {
      runs: Array<{ talkingDidHeavyWork: boolean; workerType?: string }>;
    };
    expect(onDisk.runs[0]?.talkingDidHeavyWork).toBe(false);
    expect(onDisk.runs[0]?.workerType).toBe("coder");
    const booked = JSON.parse(readFileSync(computerRoot(dir, "t1").workersFile, "utf8")) as {
      workers: Array<{ pid?: number }>;
    };
    expect(booked.workers[0]?.pid).toBeDefined();
    expect(isPidAlive(booked.workers[0]?.pid)).toBe(true);
    expect(new WorkerBook(dir).isLive("t1")).toBe(true);
    await field.kill("stop");
    expect(isPidAlive(booked.workers[0]?.pid)).toBe(false);
  });

  it("field-serve with no adapter option and no bind is ADAPTER_UNBOUND", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-think-serve-unbound-"));
    const architect = architectIssueFieldToken({
      tenantId: "t1",
      principal: "architect",
      computerBaseDir: dir,
    });
    const issued = architectIssueFieldToken({
      tenantId: "t1",
      principal: "field",
      computerBaseDir: dir,
      architectToken: architect.token,
    });
    const started = await startFieldServe({ tenantId: "t1", computerBaseDir: dir, port: 0 });
    servers.push(started.server);
    const field = new FieldClient(started.url, issued.token);
    const rec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Subject",
    );
    await field.openApproved("buyer", rec.id);
    await expect(field.start("buyer", "Work this buyer journey", rec.id)).rejects.toMatchObject({
      status: 400,
      code: "ADAPTER_UNBOUND",
    });
    expect(DeepAgentsAdapter.invocations).toBe(0);
    expect(DeepAgentsAdapter.lastModelId).toBeUndefined();
    expect(existsSync(computerRoot(dir, "t1").runsFile)).toBe(false);
    expect(existsSync(computerRoot(dir, "t1").workersFile)).toBe(false);
    expect(new WorkerBook(dir).get("t1")).toBeUndefined();
  });

  it("HTTP bind outside pack allow-list is ADAPTER_NOT_ALLOWED", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-think-http-denied-"));
    const { anchors, binding } = await signedRePackMutated((unsigned) => {
      unsigned.adapter = { allowList: ["ci-double"] };
    });
    const core = new AlphaVectorCore(anchors, path.join(dir, "state"), dir);
    const loaded = core.packs.load({ tenantId: "t1", binding, actor: "architect" });
    if (!loaded.ok) throw new Error(loaded.message);
    core.agents.instantiateFromPack(loaded.loaded, "architect");
    const architect = core.fieldTokens.issue({ tenantId: "t1", principal: "architect" });
    architectBindAdapter({
      tenantId: "t1",
      modelId: "other-model",
      computerBaseDir: dir,
      architectToken: architect.token,
    });
    const fieldToken = core.fieldTokens.issue({
      tenantId: "t1",
      principal: "field",
      presented: architect.token,
    }).token;
    const server = new FieldHttpServer({ core, pack: loaded.loaded, tenantId: "t1" });
    servers.push(server);
    const { url } = await server.listen(0, "127.0.0.1");
    const field = new FieldClient(url, fieldToken);
    const rec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Subject",
    );
    await field.openApproved("buyer", rec.id);
    await expect(field.start("buyer", "Work this buyer journey", rec.id)).rejects.toMatchObject({
      status: 400,
      code: "ADAPTER_NOT_ALLOWED",
    });
    expect(DeepAgentsAdapter.invocations).toBe(0);
    expect(core.habitat.getRun("t1")).toBeUndefined();
    expect(core.habitat.trailerExists("t1")).toBe(false);
  });

  it("allow-list bind of the declared model invokes think", async () => {
    const stack = await habitatThinkStack("t1", (unsigned) => {
      unsigned.adapter = { allowList: ["ci-double"], defaultModelId: "ci-double" };
    });
    architectBindAdapter({
      tenantId: stack.tenantId,
      modelId: "ci-double",
      computerBaseDir: stack.computerBaseDir,
      architectToken: stack.architectToken,
    });
    const started = stack.core.habitat.wake({
      kind: "field_start",
      tenantId: stack.tenantId,
      pack: stack.pack,
      goal: "one goal",
      recordId: stack.record.id,
    });
    expect(DeepAgentsAdapter.invocations).toBeGreaterThan(0);
    expect(DeepAgentsAdapter.lastModelId).toBe("ci-double");
    expect(started.launchedWorker).toBe(true);
    expect(started.run?.workerType).toBe("coder");
  });

  it("corrupt adapter-bind.json fails closed", async () => {
    const stack = await habitatThinkStack();
    const file = computerRoot(stack.computerBaseDir, stack.tenantId).adapterBindFile;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not-json", "utf8");
    expect(() =>
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      }),
    ).toThrow(/ADAPTER_BIND_CORRUPT|corrupt/i);
    expect(DeepAgentsAdapter.invocations).toBe(0);
    expect(stack.core.habitat.getRun(stack.tenantId)).toBeUndefined();
  });

  it("field SHALL NOT bind, see, or edit the adapter", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-think-http-field-"));
    const { field, fieldToken, url } = await liveProductField("t1", dir);
    expect(() =>
      architectBindAdapter({
        tenantId: "t1",
        modelId: "ci-double",
        computerBaseDir: dir,
        architectToken: fieldToken,
      }),
    ).toThrow(/cannot bind|field token/i);
    expect(existsSync(computerRoot(dir, "t1").adapterBindFile)).toBe(false);

    const home = await field.home();
    expect(JSON.stringify(home)).not.toMatch(/adapter-bind|modelId|allowList|pickAgent/);

    const blocked = await fetch(`${url}/field/adapter-bind`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ modelId: "ci-double" }),
    });
    expect(blocked.status).toBe(403);
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toBe("SURFACE_VIOLATION");
    expect(existsSync(computerRoot(dir, "t1").adapterBindFile)).toBe(false);

    const pick = await fetch(`${url}/field/pickAgent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agent: "coder" }),
    });
    expect(pick.status).toBe(404);

    const fieldSrc = readFileSync(path.join(process.cwd(), "src/http/field-server.ts"), "utf8");
    expect(fieldSrc).not.toMatch(/pickAgent/);
    expect(fieldSrc).toMatch(/\/field\/ask/);
    expect(fieldSrc).toMatch(/\/field\/kill/);
    const ios = readFileSync(path.join(process.cwd(), "clients/field-ios/Field/FieldAPI.swift"), "utf8");
    expect(ios).not.toMatch(/pickAgent/);
    expect(ios).toMatch(/func start/);
    expect(ios).toMatch(/func approve/);
    expect(ios).toMatch(/func ask/);
  });
});
