import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { SurfaceViolationError } from "../src/errors.js";
import { dryThink, DryStemAdapter } from "../src/habitat/adapter.js";
import {
  cognitiveIntentFromUnknown,
  DeepAgentsAdapter,
  fixtureTypedDecision,
  reapHeldCoders,
  TALKING_SHALL_NOT,
  WAKE_KINDS,
} from "../src/habitat/index.js";
import type { CognitiveAdapter, CognitiveIntent } from "../src/habitat/types.js";
import type { FixtureDecisionInput } from "../src/habitat/typed-decision.js";
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

function talkingIntent(intent: FixtureDecisionInput): CognitiveAdapter {
  const complete = fixtureTypedDecision(intent);
  return {
    name: "hk031-script",
    owns: ["think"],
    requiresBind: false,
    think(input) {
      if (input.pass === "worker") return dryThink(input);
      return complete;
    },
  };
}

async function habitatCore(adapter: CognitiveAdapter = new DryStemAdapter()) {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk031-"));
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

function expectTalkingReject(
  core: AlphaVectorCore,
  tenantId: string,
  code: string,
): void {
  const run = core.habitat.getRun(tenantId);
  expect(run?.talkingDidHeavyWork).toBe(false);
  expect(run?.talkingReject).toEqual({ code, closed: true });
  expect(core.habitat.listWakes(tenantId).some((w) => w.detail?.talkingReject === code && w.detail.closed === true)).toBe(
    true,
  );
}

describe("HK-031 talking SHALL NOT", () => {
  it("keeps the RE fixture pin at 5091328 and does not rewrite field home or invent brand", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const source = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(source).toMatch(/5091328a2a5d4a9429ec65fef6da5683ede1cac9/);

    const fieldHome = readFileSync(path.join(process.cwd(), "src/surfaces/field.ts"), "utf8");
    expect(fieldHome).toMatch(/home\(tenantId: string, pack\?: LoadedPack\): FieldHome/);
    expect(fieldHome).toMatch(/architectControls: \[\]/);
    expect(fieldHome).not.toMatch(/HK-031|HK-032|pickAgent/);
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
    expect(kernelSrc).toMatch(/Talking pass must not do heavy work/);
    expect(kernelSrc).toMatch(/TALKING_PASS/);
    expect(kernelSrc).not.toMatch(/T0|T1|T2|T3/);

    const shallNotSrc = readFileSync(path.join(process.cwd(), "src/habitat/talking-shall-not.ts"), "utf8");
    expect(shallNotSrc).not.toMatch(/T0|T1|T2|T3/);
    expect(shallNotSrc).not.toMatch(/HK-032/);
    for (const code of NAMED_CODES) {
      expect(shallNotSrc).toMatch(new RegExp(code));
    }
    expect(TALKING_SHALL_NOT.map((row) => row.code)).toEqual([...NAMED_CODES]);

    expect(WAKE_KINDS).toEqual([...CLOSED_V1]);
    expect(WAKE_KINDS).not.toContain("card_decided");
    expect(WAKE_KINDS).not.toContain("connector_event");
    expect(WAKE_KINDS).not.toContain("talking_reject");
  });

  it("heavy work on talking is still TALKING_PASS and talkingDidHeavyWork stays false", async () => {
    const world = await useWorldHttp();
    const heavy = await habitatCore({
      name: "hk031-heavy",
      owns: ["think"],
      requiresBind: false,
      think() {
        return fixtureTypedDecision({
          pass: "talking",
          act: "propose_effect",
          actionClass: "communicate",
          channel: "email",
        });
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
    expect(heavy.core.habitat.getRun(heavy.tenantId)?.talkingDidHeavyWork).toBe(false);
    expect(heavy.core.habitat.getRun(heavy.tenantId)?.talkingReject).toEqual({
      code: "TALKING_PASS",
      closed: true,
    });
    expect(world.requests).toHaveLength(0);
    expect(heavy.core.cards.fieldInbox(heavy.tenantId)).toHaveLength(0);
    expect(heavy.core.store.actions.some((a) => a.status === "executed")).toBe(false);
  });

  it("each other SHALL NOT is a typed closed reject that does not persist the forbidden change", async () => {
    const world = await useWorldHttp();
    const fixtures: Array<{
      code: (typeof NAMED_CODES)[number];
      intent: FixtureDecisionInput;
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
      const grantsBefore = stack.core.grants.list(stack.tenantId);
      const fixturesBefore = stack.pack.binding.evidenceEvalFixtures;
      const policyBefore = stack.pack.binding.policy;
      await expect(
        stack.core.habitat.wake({
          kind: "field_start",
          tenantId: stack.tenantId,
          pack: stack.pack,
          goal: "one goal",
          recordId: stack.record.id,
        }),
      ).rejects.toMatchObject({ code: fixture.code, closed: true });
      expectTalkingReject(stack.core, stack.tenantId, fixture.code);
      expect(stack.core.grants.list(stack.tenantId)).toEqual(grantsBefore);
      expect(stack.pack.binding.evidenceEvalFixtures).toBe(fixturesBefore);
      expect(stack.pack.binding.policy).toBe(policyBefore);
      expect(stack.core.cards.fieldInbox(stack.tenantId)).toHaveLength(0);
      expect(stack.core.store.actions.some((a) => a.status === "executed")).toBe(false);
      expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();
      expect(() => stack.core.habitat.promoteProposal({ tenantId: stack.tenantId, name: "draft" })).toThrow(
        /Habitat cannot promote itself/,
      );
      expect(world.requests).toHaveLength(0);
    }

    const fielded = await habitatCore(
      talkingIntent({
        pass: "talking",
        act: "launch_worker",
        workerType: "coder",
        ...({ grantTrust: true } as object),
      } as CognitiveIntent),
    );
    await expect(
      fielded.core.habitat.wake({
        kind: "field_start",
        tenantId: fielded.tenantId,
        pack: fielded.pack,
        goal: "one goal",
        recordId: fielded.record.id,
      }),
    ).rejects.toMatchObject({ code: "TALKING_GRANT_TRUST", closed: true });
    expect(fielded.core.grants.list(fielded.tenantId)).toHaveLength(0);
    expectTalkingReject(fielded.core, fielded.tenantId, "TALKING_GRANT_TRUST");
  });

  it("world is not invoked on a talking world-call reject; report still does not invoke the world", async () => {
    const world = await useWorldHttp();
    const rejected = await habitatCore(
      talkingIntent({
        pass: "talking",
        act: "report",
        body: "status only",
        ...({ worldCall: { channel: "email" } } as object),
      } as CognitiveIntent),
    );
    await expect(
      rejected.core.habitat.wake({
        kind: "field_start",
        tenantId: rejected.tenantId,
        pack: rejected.pack,
        goal: "one goal",
        recordId: rejected.record.id,
      }),
    ).rejects.toMatchObject({ code: "TALKING_WORLD_CALL", closed: true });
    expect(world.requests).toHaveLength(0);
    expect(rejected.core.store.actions.some((a) => a.status === "executed")).toBe(false);
    expectTalkingReject(rejected.core, rejected.tenantId, "TALKING_WORLD_CALL");

    const reported = await habitatCore(
      talkingIntent({ pass: "talking", act: "report", body: "status only" }),
    );
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

  it("propose_effect from talking still creates a card; skip-card fails closed and does not execute", async () => {
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

    const skip = await habitatCore({
      name: "hk031-skip",
      owns: ["think"],
      requiresBind: false,
      think(input) {
        if (input.pass === "worker") return dryThink(input);
        if (input.event.kind === "field_continue") {
          return fixtureTypedDecision({
            pass: "talking",
            act: "launch_worker",
            workerType: "coder",
            ...({ skipCard: true } as object),
          });
        }
        return dryThink(input);
      },
    });
    const pending = await skip.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: skip.tenantId,
        pack: skip.pack,
        goal: "one goal",
        recordId: skip.record.id,
      },
      { holdWorker: true },
    );
    const cardId = pending.cardId!;
    expect(cardId).toMatch(/^card_/);
    await expect(
      skip.core.habitat.wake({
        kind: "field_continue",
        tenantId: skip.tenantId,
        pack: skip.pack,
      }),
    ).rejects.toMatchObject({ code: "TALKING_SKIP_CARD", closed: true });
    expect(skip.core.habitat.getRun(skip.tenantId)?.pendingCardId).toBe(cardId);
    expect(skip.core.cards.get(cardId)?.status).toBe("pending");
    expect(skip.core.store.actions.some((a) => a.status === "executed")).toBe(false);
    expect(world.requests).toHaveLength(0);
    expectTalkingReject(skip.core, skip.tenantId, "TALKING_SKIP_CARD");
  });

  it("talking cannot execute an external effect except through admit + authorized worker + gateway", async () => {
    const world = await useWorldHttp();
    const bypass = await habitatCore(
      talkingIntent({
        pass: "talking",
        act: "launch_worker",
        workerType: "coder",
        ...({ executeEffect: true } as object),
      } as CognitiveIntent),
    );
    await expect(
      bypass.core.habitat.wake({
        kind: "field_start",
        tenantId: bypass.tenantId,
        pack: bypass.pack,
        goal: "one goal",
        recordId: bypass.record.id,
      }),
    ).rejects.toMatchObject({ code: "TALKING_EXECUTE_EFFECT", closed: true });
    expect(world.requests).toHaveLength(0);
    expect(bypass.core.store.actions.some((a) => a.status === "executed")).toBe(false);
    expect(bypass.core.cards.fieldInbox(bypass.tenantId)).toHaveLength(0);
    expectTalkingReject(bypass.core, bypass.tenantId, "TALKING_EXECUTE_EFFECT");

    const legal = await habitatCore();
    const architect = legal.core.fieldTokens.issue({ tenantId: legal.tenantId, principal: "architect" });
    bindWorldForPack({
      tenantId: legal.tenantId,
      computerBaseDir: legal.computerBaseDir,
      architectToken: architect.token,
      pack: legal.pack,
      baseUrl: world.url,
    });
    const started = await legal.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: legal.tenantId,
        pack: legal.pack,
        goal: "one goal",
        recordId: legal.record.id,
      },
      { holdWorker: true },
    );
    expect(started.cardId).toMatch(/^card_/);
    expect(started.effect).toBeUndefined();
    expect(world.requests).toHaveLength(0);
    legal.core.cards.resolve({ cardId: started.cardId!, decision: "approved", actor: "field" });
    const approved = await legal.core.habitat.wake({
      kind: "card_decide",
      tenantId: legal.tenantId,
      pack: legal.pack,
      cardId: started.cardId,
      decision: "approved",
    });
    expect(approved.effect?.executed).toBe(true);
    expect(world.requests.length).toBeGreaterThan(0);
    expect(legal.core.store.actions.some((a) => a.status === "executed")).toBe(true);
  });

  it("unbound adapter stays ADAPTER_UNBOUND; DryStem is fixture-only", async () => {
    const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk031-unbound-"));
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

  it("hosted talking bodies that name a SHALL NOT reach the typed reject, not ADAPTER_VENDOR_REJECTED", async () => {
    const mapped = cognitiveIntentFromUnknown({
      pass: "talking",
      act: "launch_worker",
      workerType: "coder",
      assumptions: [],
      risks: [],
      nextWake: "",
      grantTrust: true,
    });
    expect(mapped.act).toBe("launch_worker");
    expect((mapped as CognitiveIntent & { grantTrust?: unknown }).grantTrust).toBe(true);

    const actMapped = cognitiveIntentFromUnknown({
      pass: "talking",
      act: "world_call",
      assumptions: [],
      risks: [],
      nextWake: "",
    });
    expect(actMapped.act).toBe("world_call");

    try {
      cognitiveIntentFromUnknown({ pass: "talking", act: "invented_tool" });
      expect.fail("invented talking act must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: "ADAPTER_VENDOR_REJECTED", closed: true });
    }

    const stack = await habitatCore(talkingIntent(mapped));
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      }),
    ).rejects.toMatchObject({ code: "TALKING_GRANT_TRUST", closed: true });
    expectTalkingReject(stack.core, stack.tenantId, "TALKING_GRANT_TRUST");
  });

  it("rejected talking does not rewrite evaluators or success criteria", async () => {
    const stack = await habitatCore(
      talkingIntent({
        pass: "talking",
        act: "launch_worker",
        workerType: "coder",
        ...({
          alterEvaluators: { allowAll: true },
          rewriteSuccessCriteria: { passed: true },
        } as object),
      } as CognitiveIntent),
    );
    const before = stack.pack.binding.evidenceEvalFixtures;
    const policy = stack.pack.binding.policy;
    const criteria = JSON.stringify(before);
    const policyJson = JSON.stringify(policy);
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
      }),
    ).rejects.toMatchObject({ code: "TALKING_ALTER_EVALUATORS", closed: true });
    expect(stack.pack.binding.evidenceEvalFixtures).toBe(before);
    expect(stack.pack.binding.policy).toBe(policy);
    expect(JSON.stringify(stack.pack.binding.evidenceEvalFixtures)).toBe(criteria);
    expect(JSON.stringify(stack.pack.binding.policy)).toBe(policyJson);
    expect(existsSync(path.join(stack.computerBaseDir, "tenants", stack.tenantId, "skills"))).toBe(false);
  });
});
