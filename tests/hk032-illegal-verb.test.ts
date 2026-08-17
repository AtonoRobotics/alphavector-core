import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AvError, SurfaceViolationError } from "../src/errors.js";
import { dryThink, DryStemAdapter } from "../src/habitat/adapter.js";
import {
  cognitiveIntentFromUnknown,
  DeepAgentsAdapter,
  ILLEGAL_ADAPTER_VERB,
  reapHeldCoders,
  TALKING_SHALL_NOT,
  WAKE_KINDS,
} from "../src/habitat/index.js";
import type { CognitiveAdapter, CognitiveIntent } from "../src/habitat/types.js";
import { AlphaVectorCore } from "../src/kernel.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  signedGenericPack,
} from "./helpers.js";
import { bindWorldForPack, closeWorldHttp, useWorldHttp } from "./world-double.js";

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

const NAMED_CODES = [
  "TALKING_GRANT_TRUST",
  "TALKING_PROMOTE_POLICY",
  "TALKING_ALTER_EVALUATORS",
  "TALKING_REWRITE_SUCCESS_CRITERIA",
  "TALKING_SKIP_CARD",
  "TALKING_EXECUTE_EFFECT",
  "TALKING_WORLD_CALL",
] as const;

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
  await closeWorldHttp();
});

function talkingIntent(intent: CognitiveIntent): CognitiveAdapter {
  return {
    name: "hk032-script",
    owns: ["think"],
    requiresBind: false,
    think(input) {
      if (input.pass === "worker") return dryThink(input);
      return intent;
    },
  };
}

function workerIntent(intent: CognitiveIntent): CognitiveAdapter {
  return {
    name: "hk032-worker-script",
    owns: ["think"],
    requiresBind: false,
    think(input) {
      if (input.pass === "worker") return intent;
      return dryThink(input);
    },
  };
}

async function habitatCore(adapter: CognitiveAdapter = new DryStemAdapter()) {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk032-"));
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

function expectRejectEvidence(core: AlphaVectorCore, tenantId: string, code: string): void {
  const run = core.habitat.getRun(tenantId);
  expect(run?.talkingDidHeavyWork).toBe(false);
  expect(run?.talkingReject).toEqual({ code, closed: true });
  expect(
    core.habitat.listWakes(tenantId).some((w) => w.detail?.talkingReject === code && w.detail.closed === true),
  ).toBe(true);
}

describe("HK-032 illegal adapter verb", () => {
  it("keeps the RE fixture pin at 5091328 and does not rewrite field home or invent brand", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const source = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(source).toMatch(/5091328a2a5d4a9429ec65fef6da5683ede1cac9/);

    const fieldHome = readFileSync(path.join(process.cwd(), "src/surfaces/field.ts"), "utf8");
    expect(fieldHome).toMatch(/home\(tenantId: string, pack\?: LoadedPack\): FieldHome/);
    expect(fieldHome).toMatch(/architectControls: \[\]/);
    expect(fieldHome).not.toMatch(/HK-032|pickAgent|VEYRA/);
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
    expect(typesSrc).not.toMatch(/"analyst"|"researcher"|"planner"/);

    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(/ILLEGAL_ADAPTER_VERB/);
    expect(kernelSrc).toMatch(/talkingReject/);
    expect(kernelSrc).not.toMatch(/T0|T1|T2|T3/);

    const verbSrc = readFileSync(path.join(process.cwd(), "src/habitat/illegal-adapter-verb.ts"), "utf8");
    expect(verbSrc).toMatch(/ADAPTER_VENDOR_REJECTED/);
    expect(verbSrc).not.toMatch(/T0|T1|T2|T3/);
    expect(ILLEGAL_ADAPTER_VERB).toBe("ADAPTER_VENDOR_REJECTED");

    expect(TALKING_SHALL_NOT.map((row) => row.code)).toEqual([...NAMED_CODES]);
    expect(WAKE_KINDS).toEqual([...CLOSED_V1]);
    expect(WAKE_KINDS).not.toContain("card_decided");
    expect(WAKE_KINDS).not.toContain("connector_event");
    expect(WAKE_KINDS).not.toContain("talking_reject");
    expect(WAKE_KINDS).not.toContain("illegal_adapter_verb");
  });

  it("each named HK-031 code still rejects as itself and is not collapsed", async () => {
    const world = await useWorldHttp();
    const fixtures: Array<{
      code: (typeof NAMED_CODES)[number];
      intent: CognitiveIntent;
    }> = [
      { code: "TALKING_WORLD_CALL", intent: { pass: "talking", act: "world_call" as CognitiveIntent["act"] } },
      { code: "TALKING_GRANT_TRUST", intent: { pass: "talking", act: "grant_trust" as CognitiveIntent["act"] } },
      { code: "TALKING_PROMOTE_POLICY", intent: { pass: "talking", act: "promote_policy" as CognitiveIntent["act"] } },
      {
        code: "TALKING_ALTER_EVALUATORS",
        intent: { pass: "talking", act: "alter_evaluators" as CognitiveIntent["act"] },
      },
      {
        code: "TALKING_REWRITE_SUCCESS_CRITERIA",
        intent: { pass: "talking", act: "rewrite_success_criteria" as CognitiveIntent["act"] },
      },
      { code: "TALKING_SKIP_CARD", intent: { pass: "talking", act: "skip_card" as CognitiveIntent["act"] } },
      { code: "TALKING_EXECUTE_EFFECT", intent: { pass: "talking", act: "execute_effect" as CognitiveIntent["act"] } },
    ];

    for (const fixture of fixtures) {
      const stack = await habitatCore(talkingIntent(fixture.intent));
      await expect(
        stack.core.habitat.wake({
          kind: "field_start",
          tenantId: stack.tenantId,
          pack: stack.pack,
          goal: "one goal",
          recordId: stack.record.id,
        }),
      ).rejects.toMatchObject({ code: fixture.code, closed: true });
      expect(fixture.code).not.toBe(ILLEGAL_ADAPTER_VERB);
      expectRejectEvidence(stack.core, stack.tenantId, fixture.code);
      expect(stack.core.cards.fieldInbox(stack.tenantId)).toHaveLength(0);
      expect(stack.core.store.actions.some((a) => a.status === "executed")).toBe(false);
      expect(world.requests).toHaveLength(0);
    }

    const heavy = await habitatCore({
      name: "hk032-heavy",
      owns: ["think"],
      requiresBind: false,
      think() {
        return {
          pass: "talking",
          act: "propose_effect",
          actionClass: "communicate",
          channel: "email",
        };
      },
    });
    await expect(
      heavy.core.habitat.wake({
        kind: "field_start",
        tenantId: heavy.tenantId,
        pack: heavy.pack,
        goal: "one goal",
        recordId: heavy.record.id,
      }),
    ).rejects.toMatchObject({ code: "TALKING_PASS", closed: true });
    expectRejectEvidence(heavy.core, heavy.tenantId, "TALKING_PASS");
    expect(world.requests).toHaveLength(0);
  });

  it("an invented talking verb fails closed with HK-032 evidence; mapper throw is not enough alone", async () => {
    const world = await useWorldHttp();
    const invented = await habitatCore(
      talkingIntent({ pass: "talking", act: "invented_tool" as CognitiveIntent["act"] }),
    );
    await expect(
      invented.core.habitat.wake({
        kind: "field_start",
        tenantId: invented.tenantId,
        pack: invented.pack,
        goal: "one goal",
        recordId: invented.record.id,
      }),
    ).rejects.toMatchObject({ code: ILLEGAL_ADAPTER_VERB, closed: true });
    expectRejectEvidence(invented.core, invented.tenantId, ILLEGAL_ADAPTER_VERB);
    expect(invented.core.cards.fieldInbox(invented.tenantId)).toHaveLength(0);
    expect(invented.core.store.actions.some((a) => a.status === "executed")).toBe(false);
    expect(invented.core.habitat.activeWorker(invented.tenantId)).toBeUndefined();
    expect(world.requests).toHaveLength(0);

    try {
      cognitiveIntentFromUnknown({ pass: "talking", act: "invented_tool" });
      expect.fail("invented talking act must fail closed at the mapper");
    } catch (err) {
      expect(err).toMatchObject({ code: ILLEGAL_ADAPTER_VERB, closed: true });
      expect(err).toBeInstanceOf(AvError);
    }

    const hosted = await habitatCore({
      name: "hk032-hosted-invented",
      owns: ["think"],
      requiresBind: false,
      think() {
        return cognitiveIntentFromUnknown({ pass: "talking", act: "invented_tool" });
      },
    });
    await expect(
      hosted.core.habitat.wake({
        kind: "field_start",
        tenantId: hosted.tenantId,
        pack: hosted.pack,
        goal: "one goal",
        recordId: hosted.record.id,
      }),
    ).rejects.toMatchObject({ code: ILLEGAL_ADAPTER_VERB, closed: true });
    const hostedRun = hosted.core.habitat.getRun(hosted.tenantId);
    expect(hostedRun).toBeDefined();
    expect(hostedRun?.talkingReject).toEqual({ code: ILLEGAL_ADAPTER_VERB, closed: true });
    expect(
      hosted.core.habitat
        .listWakes(hosted.tenantId)
        .some((w) => w.detail?.talkingReject === ILLEGAL_ADAPTER_VERB && w.detail.closed === true),
    ).toBe(true);
    expect(world.requests).toHaveLength(0);
    expect(hosted.core.store.actions.some((a) => a.status === "executed")).toBe(false);
  });

  it("an illegal worker tool/verb fails closed with evidence and does not hit the world", async () => {
    const world = await useWorldHttp();
    const illegal = await habitatCore(
      workerIntent({ pass: "worker", act: "invented_tool" as CognitiveIntent["act"] }),
    );
    await expect(
      illegal.core.habitat.wake({
        kind: "field_start",
        tenantId: illegal.tenantId,
        pack: illegal.pack,
        goal: "one goal",
        recordId: illegal.record.id,
      }),
    ).rejects.toMatchObject({ code: ILLEGAL_ADAPTER_VERB, closed: true });
    expectRejectEvidence(illegal.core, illegal.tenantId, ILLEGAL_ADAPTER_VERB);
    expect(illegal.core.cards.fieldInbox(illegal.tenantId)).toHaveLength(0);
    expect(illegal.core.store.actions.some((a) => a.status === "executed")).toBe(false);
    expect(world.requests).toHaveLength(0);

    const skip = await habitatCore(
      workerIntent({
        pass: "worker",
        act: "skip_card" as CognitiveIntent["act"],
      }),
    );
    await expect(
      skip.core.habitat.wake({
        kind: "field_start",
        tenantId: skip.tenantId,
        pack: skip.pack,
        goal: "one goal",
        recordId: skip.record.id,
      }),
    ).rejects.toMatchObject({ code: ILLEGAL_ADAPTER_VERB, closed: true });
    expectRejectEvidence(skip.core, skip.tenantId, ILLEGAL_ADAPTER_VERB);
    expect(skip.core.cards.fieldInbox(skip.tenantId)).toHaveLength(0);
    expect(world.requests).toHaveLength(0);
  });

  it("legal worker propose_effect still creates a card; report still does not invoke the world", async () => {
    const world = await useWorldHttp();
    const carded = await habitatCore();
    const started = await carded.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: carded.tenantId,
        pack: carded.pack,
        goal: "one goal",
        recordId: carded.record.id,
      },
      { holdWorker: true },
    );
    expect(started.cardId).toMatch(/^card_/);
    expect(started.run?.status).toBe("awaiting_card");
    expect(started.effect).toBeUndefined();
    expect(started.talkingDidHeavyWork).toBe(false);
    expect(carded.core.cards.get(started.cardId!)?.status).toBe("pending");
    expect(carded.core.store.actions.some((a) => a.status === "executed")).toBe(false);
    expect(world.requests).toHaveLength(0);

    const reported = await habitatCore(talkingIntent({ pass: "talking", act: "report", body: "status only" }));
    const result = await reported.core.habitat.wake({
      kind: "field_start",
      tenantId: reported.tenantId,
      pack: reported.pack,
      goal: "one goal",
      recordId: reported.record.id,
    });
    expect(result.report).toEqual({
      body: "status only",
      executedEffect: false,
      cardRequired: false,
    });
    expect(result.effect).toBeUndefined();
    expect(result.cardId).toBeUndefined();
    expect(world.requests).toHaveLength(0);
    expect(reported.core.store.actions.some((a) => a.status === "executed")).toBe(false);
  });

  it("unbound adapter stays ADAPTER_UNBOUND; DryStem is fixture-only", async () => {
    const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk032-unbound-"));
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
  });

  it("field-supplied run controls stay SURFACE_VIOLATION / FIELD_CANNOT_PICK_AGENT", async () => {
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
        workerType: "coder",
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
  });
});
