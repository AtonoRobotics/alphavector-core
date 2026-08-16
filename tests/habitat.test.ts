import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryTiers } from "../src/agents/memory.js";
import { computerRoot } from "../src/computer/paths.js";
import { EvalRunner } from "../src/eval/runner.js";
import { AvError } from "../src/errors.js";
import { createDeepAgent, DeepAgentsAdapter, HABITAT_OWNED } from "../src/habitat/index.js";
import { FieldClient, FieldHttpError } from "../src/http/field-client.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { AlphaVectorCore } from "../src/kernel.js";
import { RecordBook } from "../src/records/book.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  createOpenStart,
  expectPresentIdsDeniedWithoutRecord,
  makeAnchors,
  signedGenericPack,
} from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const servers: FieldHttpServer[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.close();
  }
});

async function habitatStack(tenantId = "t1") {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-habitat-"));
  const { anchors, binding } = await signedGenericPack();
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir);
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

async function liveField(tenantId: string, computerBaseDir: string) {
  const { core, pack } = await bootFieldCore(tenantId, { computerBaseDir });
  const architect = core.fieldTokens.issue({ tenantId, principal: "architect" });
  const fieldToken = core.fieldTokens.issue({
    tenantId,
    principal: "field",
    presented: architect.token,
  }).token;
  const server = new FieldHttpServer({ core, pack, tenantId });
  servers.push(server);
  const { url } = await server.listen(0, "127.0.0.1");
  return { core, pack, field: new FieldClient(url, fieldToken), fieldToken, url };
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
    expect(existsSync(path.join(computerRoot(dir, "t1").disk, "runs.json"))).toBe(false);
    const wakes = core.habitat.listWakes("t1");
    expect(wakes.some((w) => w.kind === "field_start")).toBe(true);
    expect(core.habitat.trailerExists("t1")).toBe(true);
    expect(run!.talkingDidHeavyWork).toBe(false);
    expect(run!.status).toBe("awaiting_card");
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
    expect(fieldSrc).toMatch(/\/field\/ask/);
    expect(fieldSrc).toMatch(/\/field\/kill/);
    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(/return this\.wake\(\{ \.\.\.event, kind: "field_start" \}\);/);
    expect(kernelSrc).not.toMatch(/wake\(\{ \.\.\.event, kind: "field_start" \},\s*\{\s*until:\s*["']talking["']/);
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
    expect(core.habitat.trailerExists("t1")).toBe(true);
    expect(again?.talkingDidHeavyWork).toBe(false);
    expect(core.store.actions.filter((a) => a.status === "executed")).toHaveLength(0);
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

  it("field ask stays available and does not pick an agent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hab-ask-"));
    const { field } = await liveField("t1", dir);
    await expect(field.ask("status?", "read")).resolves.toEqual({ ok: true });
  });
});
