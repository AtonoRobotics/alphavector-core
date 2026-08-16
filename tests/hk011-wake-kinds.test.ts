import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { architectSit } from "../src/auth/architect-habitat.js";
import { architectDeliverMessage } from "../src/auth/architect-message.js";
import { SurfaceViolationError } from "../src/errors.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import { DeepAgentsAdapter, isPidAlive, reapHeldCoders, WAKE_KINDS } from "../src/habitat/index.js";
import { stem } from "../src/habitat/stem.js";
import type { WakeKind } from "../src/habitat/types.js";
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

/**
 * Closed v1 set from HK-011 plus the existing names this slice must not rename.
 * Adding a kind outside this union is a spec change.
 */
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

afterEach(async () => {
  reapHeldCoders();
  while (servers.length) {
    await servers.pop()?.close();
  }
});

function runArchitectCli(
  args: string[],
  opts: { computerBaseDir: string; architectToken?: string },
): { stdout: string; stderr: string; status: number } {
  const viteNode = path.join(process.cwd(), "node_modules/vite-node/dist/cli.mjs");
  const cli = path.join(process.cwd(), "src/cli.ts");
  try {
    const stdout = execFileSync(process.execPath, [viteNode, cli, ...args], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: {
        ...process.env,
        AV_COMPUTER_DIR: opts.computerBaseDir,
        ...(opts.architectToken ? { AV_ARCHITECT_TOKEN: opts.architectToken } : {}),
      },
      timeout: 30_000,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
      status: typeof e.status === "number" ? e.status : 1,
    };
  }
}

async function habitatCore(tenantId = "t1") {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk011-"));
  const { anchors, binding } = await signedGenericPack();
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir, {
    adapter: new DryStemAdapter(),
  });
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
    core,
    pack: loaded.loaded,
    tenantId,
    agents,
    record,
    architectToken: architect.token,
    fieldToken: field.token,
    orch: agents.find((a) => a.isOrchestrator)!,
    role: agents.find((a) => !a.isOrchestrator)!,
  };
}

async function liveHttp(tenantId = "hk011") {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk011-http-"));
  const { core, pack } = await bootTestFieldCore(tenantId, {
    computerBaseDir,
    adapter: new DryStemAdapter(),
  });
  const architect = core.fieldTokens.issue({ tenantId, principal: "architect" });
  const field = core.fieldTokens.issue({
    tenantId,
    principal: "field",
    presented: architect.token,
  });
  const server = new FieldHttpServer({ core, pack, tenantId });
  servers.push(server);
  const { url } = await server.listen(0, "127.0.0.1");
  return {
    url,
    core,
    pack,
    tenantId,
    computerBaseDir,
    architectToken: architect.token,
    fieldToken: field.token,
  };
}

describe("HK-011 closed v1 wake kinds", () => {
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

    const iosHome = readFileSync(path.join(REPO_ROOT, "clients/field-ios/Field/HomeView.swift"), "utf8");
    expect(iosHome).not.toMatch(/architect_message|VEYRA|Architect Desktop/i);

    const identity = readFileSync(path.join(process.cwd(), "src/identity.ts"), "utf8");
    expect(identity).toMatch(/appDisplay: "AV Dev"/);
    expect(identity).toMatch(/"VEYRA"/);
  });

  it("adds only architect_message and worker_failed; no kind outside the closed set", () => {
    expect(WAKE_KINDS).toContain("architect_message");
    expect(WAKE_KINDS).toContain("worker_failed");
    expect(WAKE_KINDS).toContain("field_continue");
    expect(WAKE_KINDS).toContain("card_decide");
    expect(WAKE_KINDS).toContain("connector");
    expect(WAKE_KINDS).not.toContain("card_decided");
    expect(WAKE_KINDS).not.toContain("connector_event");
    for (const kind of WAKE_KINDS) {
      expect(CLOSED_V1_PLUS_EXISTING.has(kind), `unexpected WakeKind ${kind}`).toBe(true);
    }
    expect(stem({ kind: "architect_message", tenantId: "t1" })).toEqual({
      wakeOrchestrator: true,
      wakeOps: false,
    });
    expect(stem({ kind: "worker_failed", tenantId: "t1" })).toEqual({
      wakeOrchestrator: true,
      wakeOps: false,
    });
    expect(stem({ kind: "worker_done", tenantId: "t1" })).toEqual({
      wakeOrchestrator: true,
      wakeOps: true,
    });

    const typesSrc = readFileSync(path.join(process.cwd(), "src/habitat/types.ts"), "utf8");
    expect(typesSrc).toMatch(/"architect_message"/);
    expect(typesSrc).toMatch(/"worker_failed"/);
    expect(typesSrc).toMatch(/"field_continue"/);
    expect(typesSrc).toMatch(/"card_decide"/);
    expect(typesSrc).toMatch(/"connector"/);
    expect(typesSrc).not.toMatch(/"card_decided"/);
    expect(typesSrc).not.toMatch(/"connector_event"/);
  });

  it("architect_message is a typed WakeKind and a real habitat.wake that loads the orchestrator", async () => {
    const stack = await habitatCore();
    await stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { holdWorker: true },
    );
    stack.core.habitat.memory.writeProfile({
      tenantId: stack.tenantId,
      agentId: stack.orch.agentId,
      note: "orch-architect-message",
    });
    stack.core.habitat.memory.writeProfile({
      tenantId: stack.tenantId,
      agentId: stack.role.agentId,
      note: "role-architect-message",
    });
    const before = stack.core.habitat.listWakes(stack.tenantId).length;
    const runId = stack.core.habitat.getRun(stack.tenantId)!.runId;

    const woke = await stack.core.habitat.wake({
      kind: "architect_message" satisfies WakeKind,
      tenantId: stack.tenantId,
      pack: stack.pack,
      fromAgentId: "architect",
      goal: "status on the open goal",
    });

    expect(woke.wokeOrchestrator).toBe(true);
    expect(woke.launchedWorker).toBe(false);
    expect(woke.talkingDidHeavyWork).toBe(false);
    expect(woke.run?.runId).toBe(runId);
    expect(woke.memory.profile.agentId).toBe(stack.orch.agentId);
    expect(woke.memory.profile.body?.notes).toContain("orch-architect-message");
    expect(woke.memory.profile.body?.notes ?? []).not.toContain("role-architect-message");

    const wakes = stack.core.habitat.listWakes(stack.tenantId);
    expect(wakes.length).toBeGreaterThan(before);
    const entry = wakes.find((w) => w.kind === "architect_message");
    expect(entry).toBeDefined();
    expect(entry?.runId).toBe(runId);
    expect(entry?.decision).toEqual({ wakeOrchestrator: true, wakeOps: false });
    expect(entry?.detail).toMatchObject({
      fromAgentId: "architect",
      loadedAgentId: stack.orch.agentId,
    });
  });

  it("architect_message with an addressed role-agent loads that agent, not a silent no-op", async () => {
    const stack = await habitatCore();
    await stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { holdWorker: true },
    );
    stack.core.habitat.memory.writeProfile({
      tenantId: stack.tenantId,
      agentId: stack.role.agentId,
      note: "addressed-role",
    });
    stack.core.habitat.memory.writeLog({
      tenantId: stack.tenantId,
      agentId: stack.role.agentId,
      text: "role-log",
    });

    const woke = await architectDeliverMessage({
      tenantId: stack.tenantId,
      body: "look at this role",
      addresseeId: stack.role.agentId,
      computerBaseDir: stack.computerBaseDir,
      habitat: stack.core.habitat,
      architectToken: stack.architectToken,
    });

    expect(woke.wokeOrchestrator).toBe(true);
    expect(woke.memory.profile.agentId).toBe(stack.role.agentId);
    expect(woke.memory.profile.agentId).not.toBe(stack.orch.agentId);
    expect(woke.memory.profile.body?.notes).toContain("addressed-role");
    expect(woke.memory.logs.entries.some((e) => e.text === "role-log")).toBe(true);
    expect(stack.core.habitat.listWakes(stack.tenantId).some((w) => w.kind === "architect_message")).toBe(
      true,
    );

    await expect(
      architectDeliverMessage({
        tenantId: stack.tenantId,
        body: "ghost",
        addresseeId: "agent_does_not_exist",
        computerBaseDir: stack.computerBaseDir,
        habitat: stack.core.habitat,
        architectToken: stack.architectToken,
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND", closed: true });
  });

  it("architectSit / sit() is still a read: no wake appended, no run created", async () => {
    const stack = await habitatCore();
    expect(stack.core.habitat.listWakes(stack.tenantId)).toEqual([]);
    expect(stack.core.habitat.getRun(stack.tenantId)).toBeUndefined();

    const empty = architectSit({
      tenantId: stack.tenantId,
      computerBaseDir: stack.computerBaseDir,
      surface: stack.core.architect,
      architectToken: stack.architectToken,
    });
    expect(empty.runs).toEqual([]);
    expect(stack.core.habitat.listWakes(stack.tenantId)).toEqual([]);
    expect(stack.core.habitat.getRun(stack.tenantId)).toBeUndefined();
    expect(stack.core.architect.sit(stack.tenantId)).toEqual(empty);

    await stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { holdWorker: true },
    );
    const wakesBefore = stack.core.habitat.listWakes(stack.tenantId);
    const runBefore = stack.core.habitat.getRun(stack.tenantId);
    const seated = architectSit({
      tenantId: stack.tenantId,
      computerBaseDir: stack.computerBaseDir,
      surface: stack.core.architect,
      architectToken: stack.architectToken,
    });
    expect(seated.runs).toHaveLength(1);
    expect(stack.core.habitat.listWakes(stack.tenantId)).toEqual(wakesBefore);
    expect(stack.core.habitat.getRun(stack.tenantId)?.runId).toBe(runBefore?.runId);
    expect(wakesBefore.some((w) => w.kind === "architect_message")).toBe(false);
  });

  it("field cannot issue architect_message (SURFACE_VIOLATION)", async () => {
    const stack = await habitatCore();
    await stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { holdWorker: true },
    );

    await expect(
      architectDeliverMessage({
        tenantId: stack.tenantId,
        body: "forged",
        computerBaseDir: stack.computerBaseDir,
        habitat: stack.core.habitat,
        architectToken: stack.fieldToken,
      }),
    ).rejects.toBeInstanceOf(SurfaceViolationError);
    await expect(
      architectDeliverMessage({
        tenantId: stack.tenantId,
        body: "forged",
        computerBaseDir: stack.computerBaseDir,
        habitat: stack.core.habitat,
        architectToken: stack.fieldToken,
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION", closed: true });

    const live = await liveHttp();
    const rec = live.core.records.put(live.tenantId, { type: "case", label: "Subject" });
    await live.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: live.tenantId,
        pack: live.pack,
        goal: "http goal",
        recordId: rec.id,
      },
      { holdWorker: true },
    );

    const fieldArchitect = await fetch(`${live.url}/architect/message`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${live.fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: "forged" }),
    });
    expect(fieldArchitect.status).toBe(403);
    expect(((await fieldArchitect.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");

    const fieldPath = await fetch(`${live.url}/field/architect-message`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${live.fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: "forged" }),
    });
    expect(fieldPath.status).toBe(403);
    expect(((await fieldPath.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");

    const architectOk = await fetch(`${live.url}/architect/message`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${live.architectToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: "from architect" }),
    });
    expect(architectOk.status).toBe(200);
    const body = (await architectOk.json()) as { kind: string; wokeOrchestrator: boolean };
    expect(body.kind).toBe("architect_message");
    expect(body.wokeOrchestrator).toBe(true);

    const fieldCli = runArchitectCli(["architect", "message", "--tenant", stack.tenantId, "--body", "no"], {
      computerBaseDir: stack.computerBaseDir,
      architectToken: stack.fieldToken,
    });
    expect(fieldCli.status).not.toBe(0);
    expect(`${fieldCli.stdout}\n${fieldCli.stderr}`).toMatch(/SURFACE_VIOLATION|field token|architect message/i);
  });

  it("worker_failed is a typed wake that wakes the orchestrator and is not worker_done", async () => {
    const stack = await habitatCore();
    const started = await stack.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      },
      { holdWorker: true },
    );
    expect(started.run?.workerId).toMatch(/^worker_/);
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeDefined();
    const runId = started.run!.runId;
    const workerId = started.run!.workerId;

    const failed = await stack.core.habitat.reportWorkerFailed({
      tenantId: stack.tenantId,
      workerId,
      reason: "coder exited",
    });

    expect(failed.wokeOrchestrator).toBe(true);
    expect(failed.launchedWorker).toBe(false);
    expect(failed.run?.runId).toBe(runId);
    expect(failed.run?.status).not.toBe("completed");
    expect(failed.memory.profile.agentId).toBe(stack.orch.agentId);
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();

    const wakes = stack.core.habitat.listWakes(stack.tenantId);
    expect(wakes.some((w) => w.kind === "worker_failed" && w.runId === runId)).toBe(true);
    expect(wakes.some((w) => w.kind === "worker_done")).toBe(false);
    expect(wakes.find((w) => w.kind === "worker_failed")?.decision).toEqual({
      wakeOrchestrator: true,
      wakeOps: false,
    });
    expect(wakes.find((w) => w.kind === "worker_failed")?.detail).toMatchObject({
      workerId,
      reason: "coder exited",
    });

    const direct = await stack.core.habitat.wake({
      kind: "worker_failed" satisfies WakeKind,
      tenantId: stack.tenantId,
      pack: stack.pack,
      reason: "second fail",
    });
    expect(direct.wokeOrchestrator).toBe(true);
    expect(stack.core.habitat.listWakes(stack.tenantId).filter((w) => w.kind === "worker_done")).toEqual([]);
  });

  it("unbound adapter stays ADAPTER_UNBOUND on architect_message; DryStem is fixture-only", async () => {
    const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk011-unbound-"));
    const { anchors, binding } = await signedGenericPack();
    const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir);
    const loaded = core.packs.load({ tenantId: "t1", binding, actor: "architect" });
    if (!loaded.ok) throw new Error(loaded.message);
    core.agents.instantiateFromPack(loaded.loaded, "architect");
    const record = core.records.put("t1", { type: "case", label: "Subject" });
    expect(core.habitat.cognitiveAdapterName()).toBe("deepagents");
    expect(core.habitat.cognitiveAdapterName()).not.toBe("dry-stem");

    await expect(
      core.habitat.wake({
        kind: "field_start",
        tenantId: "t1",
        pack: loaded.loaded,
        goal: "one goal",
        recordId: record.id,
      }),
    ).rejects.toMatchObject({ code: "ADAPTER_UNBOUND", closed: true });

    const dry = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state-dry"), computerBaseDir, {
      adapter: new DryStemAdapter(),
    });
    const dryLoaded = dry.packs.load({ tenantId: "t1", binding, actor: "architect" });
    if (!dryLoaded.ok) throw new Error(dryLoaded.message);
    dry.agents.instantiateFromPack(dryLoaded.loaded, "architect");
    const dryRecord = dry.records.put("t1", { type: "case", label: "Subject" });
    await dry.habitat.wake(
      {
        kind: "field_start",
        tenantId: "t1",
        pack: dryLoaded.loaded,
        goal: "one goal",
        recordId: dryRecord.id,
      },
      { until: "talking" },
    );
    expect(dry.habitat.cognitiveAdapterName()).toBe("dry-stem");

    const product = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state-msg"), computerBaseDir);
    const productLoaded = product.packs.load({ tenantId: "t1", binding, actor: "architect" });
    if (!productLoaded.ok) throw new Error(productLoaded.message);
    product.agents.instantiateFromPack(productLoaded.loaded, "architect");
    product.habitat.setPack("t1", productLoaded.loaded);
    const open = dry.habitat.getRun("t1");
    expect(open).toBeDefined();
    await expect(
      new DeepAgentsAdapter().think({
        pass: "talking",
        event: { kind: "architect_message", tenantId: "t1" },
        run: open!,
        memory: dry.habitat.memory.labeled("t1", dry.agents.list("t1").find((a) => a.isOrchestrator)!.agentId),
        skills: [],
      }),
    ).rejects.toMatchObject({ code: "ADAPTER_UNBOUND", closed: true });
  });

  it("sit source stays a read and kernel owns both new wakes at every insertion point", () => {
    const sitSrc = readFileSync(path.join(process.cwd(), "src/auth/architect-habitat.ts"), "utf8");
    expect(sitSrc).toMatch(/Not a write-\* verb/);
    expect(sitSrc).toMatch(/return input\.surface\.sit\(input\.tenantId\)/);
    expect(sitSrc).not.toMatch(/habitat\.wake/);
    expect(sitSrc).not.toMatch(/architect_message/);

    const cliSrc = readFileSync(path.join(process.cwd(), "src/cli.ts"), "utf8");
    expect(cliSrc).toMatch(/architectSit/);
    expect(cliSrc).toMatch(/habitat reads live org, open runs, workers, grants, eval, isolation/);
    expect(cliSrc).not.toMatch(/write-habitat/);
    const habitatCli = cliSrc.slice(cliSrc.indexOf('if (sub === "habitat")'), cliSrc.indexOf('if (sub === "issue-field-token")'));
    expect(habitatCli).toMatch(/architectSit/);
    expect(habitatCli).not.toMatch(/\.wake\(/);
    expect(habitatCli).not.toMatch(/architect_message|worker_failed/);

    const fieldSrc = readFileSync(path.join(process.cwd(), "src/http/field-server.ts"), "utf8");
    expect(fieldSrc).toMatch(/\/architect\/habitat/);
    expect(fieldSrc).not.toMatch(/app\.post\(["']\/field\/architect/);
    expect(fieldSrc).toMatch(/Field cannot issue architect_message/);
    const habitatRoute = fieldSrc.slice(
      fieldSrc.indexOf("private routeArchitectHabitat"),
      fieldSrc.indexOf("private principalOf"),
    );
    expect(habitatRoute).toMatch(/\.sit\(/);
    expect(habitatRoute).not.toMatch(/\.wake\(/);
    expect(habitatRoute).not.toMatch(/architect_message|worker_failed/);

    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(/kind === "architect_message"/);
    expect(kernelSrc).toMatch(/kind === "worker_failed"/);
    expect(kernelSrc).toMatch(/deliverArchitectMessage\(/);
    expect(kernelSrc).toMatch(/reportWorkerFailed\(/);
    expect(kernelSrc).toMatch(/reapCrashedWorkers\(/);
    expect(kernelSrc).toMatch(/kind === "architect_message" \|\| kind === "worker_failed"/);
    expect(kernelSrc).toMatch(/A read\. Does not emit worker_failed/);
    expect(kernelSrc).not.toMatch(/createDeepAgent\s*\(/);
    expect(kernelSrc).toMatch(/isolation\(tenantId: string\): HabitatIsolationRecord/);

    const stemSrc = readFileSync(path.join(process.cwd(), "src/habitat/stem.ts"), "utf8");
    expect(stemSrc).toMatch(/case "architect_message":/);
    expect(stemSrc).toMatch(/case "worker_failed":/);

    const wakeLogSrc = readFileSync(path.join(process.cwd(), "src/habitat/wake-log.ts"), "utf8");
    expect(wakeLogSrc).toMatch(/"architect_message"/);
    expect(wakeLogSrc).toMatch(/"worker_failed"/);
    expect(wakeLogSrc).toMatch(/WAKE_LOG_MISMATCH/);
  });

  it("a held worker crash emits worker_failed and wakes the orchestrator; isolation stays a read", async () => {
    const stack = await habitatCore();
    const started = await stack.core.habitat.wake(
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
    expect(worker?.pid).toBeDefined();
    expect(isPidAlive(worker?.pid)).toBe(true);
    const runId = started.run!.runId;
    const workerId = worker!.workerId;
    const wakesBeforeKill = stack.core.habitat.listWakes(stack.tenantId).length;

    try {
      process.kill(worker!.pid!, "SIGKILL");
    } catch {
      // already gone
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && isPidAlive(worker?.pid)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    expect(isPidAlive(worker?.pid)).toBe(false);

    const seat = stack.core.habitat.isolation(stack.tenantId);
    expect(seat.live).toBe(false);
    expect(seat.workerId).toBe(workerId);
    expect(stack.core.habitat.listWakes(stack.tenantId)).toHaveLength(wakesBeforeKill);
    expect(stack.core.habitat.listWakes(stack.tenantId).some((w) => w.kind === "worker_failed")).toBe(
      false,
    );

    await stack.core.habitat.advanceClock(new Date().toISOString());
    const wakes = stack.core.habitat.listWakes(stack.tenantId);
    expect(wakes.some((w) => w.kind === "worker_failed" && w.runId === runId)).toBe(true);
    expect(wakes.some((w) => w.kind === "worker_done")).toBe(false);
    expect(wakes.some((w) => w.kind === "kill")).toBe(false);
    expect(wakes.find((w) => w.kind === "worker_failed")?.decision).toEqual({
      wakeOrchestrator: true,
      wakeOps: false,
    });
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();
    expect(stack.core.habitat.getRun(stack.tenantId)?.status).not.toBe("completed");
    expect(stack.core.habitat.getRun(stack.tenantId)?.status).not.toBe("killed");
  });
});
