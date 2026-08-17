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
  cognitiveIntentFromUnknown,
  DECISION_ASSUMPTIONS,
  DECISION_NEXT_WAKE_OR_STOP,
  DECISION_RISKS,
  fixtureTypedDecision,
  reapHeldCoders,
  WAKE_KINDS,
} from "../src/habitat/index.js";
import type { CognitiveAdapter, CognitiveIntent } from "../src/habitat/types.js";
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

function talkingRaw(intent: CognitiveIntent): CognitiveAdapter {
  return {
    name: "hk052-talking",
    owns: ["think"],
    requiresBind: false,
    think(input) {
      if (input.pass === "worker") return dryThink(input);
      return intent;
    },
  };
}

function workerRaw(intent: CognitiveIntent): CognitiveAdapter {
  return {
    name: "hk052-worker",
    owns: ["think"],
    requiresBind: false,
    think(input) {
      if (input.pass === "worker") return intent;
      return dryThink(input);
    },
  };
}

async function habitatCore(adapter: CognitiveAdapter = new DryStemAdapter()) {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk052-"));
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

function expectRejectEvidence(core: AlphaVectorCore, tenantId: string, code: string): void {
  const run = core.habitat.getRun(tenantId);
  expect(run?.talkingDidHeavyWork).toBe(false);
  expect(run?.talkingReject).toEqual({ code, closed: true });
  expect(
    core.habitat.listWakes(tenantId).some((w) => w.detail?.talkingReject === code && w.detail.closed === true),
  ).toBe(true);
}

describe("HK-052 typed decision", () => {
  it("keeps the RE fixture pin at 5091328 and does not rewrite field home", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const source = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(source).toMatch(/5091328a2a5d4a9429ec65fef6da5683ede1cac9/);

    const fieldHome = readFileSync(path.join(process.cwd(), "src/surfaces/field.ts"), "utf8");
    expect(fieldHome).toMatch(/home\(tenantId: string, pack\?: LoadedPack\): FieldHome/);
    expect(fieldHome).toMatch(/architectControls: \[\]/);
    const changed = changedFilesAgainstMain();
    if (changed) {
      expect(changed).not.toContain("src/surfaces/field.ts");
    }
    const working = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      encoding: "utf8",
      cwd: process.cwd(),
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(working).not.toContain("src/surfaces/field.ts");

    expect(WAKE_KINDS).toEqual([...CLOSED_V1]);
    expect(WAKE_KINDS).not.toContain("card_decided");
    expect(WAKE_KINDS).not.toContain("next_wake");
    expect(WAKE_KINDS).not.toContain("typed_decision");
  });

  it("a think result missing assumptions or risks is fail-closed with no persist and no launch", async () => {
    const due = "2026-08-17T12:00:00.000Z";
    const missingAssumptions = await habitatCore(
      talkingRaw({
        pass: "talking",
        act: "launch_worker",
        workerType: "coder",
        risks: ["none named"],
        nextWake: due,
      } as CognitiveIntent),
    );
    await expect(
      missingAssumptions.core.habitat.wake({
        kind: "field_start",
        tenantId: missingAssumptions.tenantId,
        pack: missingAssumptions.pack,
        goal: "one goal",
        recordId: missingAssumptions.record.id,
      }),
    ).rejects.toMatchObject({ code: DECISION_ASSUMPTIONS, closed: true });
    expectRejectEvidence(missingAssumptions.core, missingAssumptions.tenantId, DECISION_ASSUMPTIONS);
    expect(missingAssumptions.core.habitat.getRun(missingAssumptions.tenantId)?.nextWake).toBe("");
    expect(readDiskRun(missingAssumptions.computerBaseDir, missingAssumptions.tenantId).run?.nextWake ?? "").toBe(
      "",
    );
    expect(missingAssumptions.core.habitat.activeWorker(missingAssumptions.tenantId)).toBeUndefined();
    expect(existsSync(computerRoot(missingAssumptions.computerBaseDir, missingAssumptions.tenantId).workersFile)).toBe(
      false,
    );
    expect(missingAssumptions.core.cards.fieldInbox(missingAssumptions.tenantId)).toHaveLength(0);

    const missingRisks = await habitatCore(
      talkingRaw({
        pass: "talking",
        act: "follow_up",
        assumptions: ["worker can continue"],
        nextWake: due,
      } as CognitiveIntent),
    );
    await expect(
      missingRisks.core.habitat.wake(
        {
          kind: "field_start",
          tenantId: missingRisks.tenantId,
          pack: missingRisks.pack,
          goal: "one goal",
          recordId: missingRisks.record.id,
        },
        { until: "talking" },
      ),
    ).rejects.toMatchObject({ code: DECISION_RISKS, closed: true });
    expectRejectEvidence(missingRisks.core, missingRisks.tenantId, DECISION_RISKS);
    expect(missingRisks.core.habitat.getRun(missingRisks.tenantId)?.nextWake).toBe("");
    expect(readDiskRun(missingRisks.computerBaseDir, missingRisks.tenantId).run?.nextWake ?? "").toBe("");
    expect(missingRisks.core.habitat.activeWorker(missingRisks.tenantId)).toBeUndefined();

    const workerMissing = await habitatCore(
      workerRaw({
        pass: "worker",
        act: "propose_effect",
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        risks: [],
        nextWake: "",
      } as CognitiveIntent),
    );
    await expect(
      workerMissing.core.habitat.wake({
        kind: "field_start",
        tenantId: workerMissing.tenantId,
        pack: workerMissing.pack,
        goal: "one goal",
        recordId: workerMissing.record.id,
      }),
    ).rejects.toMatchObject({ code: DECISION_ASSUMPTIONS, closed: true });
    expectRejectEvidence(workerMissing.core, workerMissing.tenantId, DECISION_ASSUMPTIONS);
    expect(workerMissing.core.cards.fieldInbox(workerMissing.tenantId)).toHaveLength(0);
    expect(workerMissing.core.store.actions.some((a) => a.status === "executed")).toBe(false);
  });

  it("a think result with act not done and no nextWake is fail-closed", async () => {
    const stack = await habitatCore(
      talkingRaw({
        pass: "talking",
        act: "follow_up",
        assumptions: ["open run continues"],
        risks: ["stale brief"],
      } as CognitiveIntent),
    );
    await expect(
      stack.core.habitat.wake(
        {
          kind: "field_start",
          tenantId: stack.tenantId,
          pack: stack.pack,
          goal: "one goal",
          recordId: stack.record.id,
        },
        { until: "talking" },
      ),
    ).rejects.toMatchObject({ code: DECISION_NEXT_WAKE_OR_STOP, closed: true });
    expectRejectEvidence(stack.core, stack.tenantId, DECISION_NEXT_WAKE_OR_STOP);
    expect(stack.core.habitat.getRun(stack.tenantId)?.nextWake).toBe("");
    expect(readDiskRun(stack.computerBaseDir, stack.tenantId).run?.nextWake ?? "").toBe("");
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();

    const worker = await habitatCore(
      workerRaw({
        pass: "worker",
        act: "propose_effect",
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        assumptions: [],
        risks: [],
      } as CognitiveIntent),
    );
    await expect(
      worker.core.habitat.wake({
        kind: "field_start",
        tenantId: worker.tenantId,
        pack: worker.pack,
        goal: "one goal",
        recordId: worker.record.id,
      }),
    ).rejects.toMatchObject({ code: DECISION_NEXT_WAKE_OR_STOP, closed: true });
    expectRejectEvidence(worker.core, worker.tenantId, DECISION_NEXT_WAKE_OR_STOP);
    expect(worker.core.cards.fieldInbox(worker.tenantId)).toHaveLength(0);
  });

  it("a valid decision is accepted and kernel persists nextWake only after validation", async () => {
    const due = "2026-08-17T15:00:00.000Z";
    const rejected = await habitatCore(
      talkingRaw({
        pass: "talking",
        act: "follow_up",
        nextWake: due,
        risks: [],
      } as CognitiveIntent),
    );
    await expect(
      rejected.core.habitat.wake(
        {
          kind: "field_start",
          tenantId: rejected.tenantId,
          pack: rejected.pack,
          goal: "one goal",
          recordId: rejected.record.id,
        },
        { until: "talking" },
      ),
    ).rejects.toMatchObject({ code: DECISION_ASSUMPTIONS, closed: true });
    expect(rejected.core.habitat.getRun(rejected.tenantId)?.nextWake).toBe("");
    expect(readDiskRun(rejected.computerBaseDir, rejected.tenantId).run?.nextWake ?? "").toBe("");

    const scheduled = await habitatCore(
      talkingRaw({
        pass: "talking",
        act: "follow_up",
        assumptions: ["field will continue"],
        risks: ["due time is a guess"],
        nextWake: due,
      }),
    );
    const talking = await scheduled.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: scheduled.tenantId,
        pack: scheduled.pack,
        goal: "one goal",
        recordId: scheduled.record.id,
      },
      { until: "talking" },
    );
    expect(talking.launchedWorker).toBe(false);
    expect(talking.run?.nextWake).toBe(due);
    expect(talking.run?.talkingReject).toBeUndefined();
    expect(readDiskRun(scheduled.computerBaseDir, scheduled.tenantId).run?.nextWake).toBe(due);

    const stopped = await habitatCore(
      talkingRaw({
        pass: "talking",
        act: "done",
        assumptions: [],
        risks: [],
      }),
    );
    const done = await stopped.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: stopped.tenantId,
        pack: stopped.pack,
        goal: "one goal",
        recordId: stopped.record.id,
      },
      { until: "talking" },
    );
    expect(done.launchedWorker).toBe(false);
    expect(done.run?.nextWake).toBe("");
    expect(done.run?.talkingReject).toBeUndefined();

    const none = await habitatCore(
      talkingRaw(
        fixtureTypedDecision({
          pass: "talking",
          act: "follow_up",
          assumptions: [],
          risks: [],
          nextWake: "",
        }),
      ),
    );
    const cleared = await none.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: none.tenantId,
        pack: none.pack,
        goal: "one goal",
        recordId: none.record.id,
      },
      { until: "talking" },
    );
    expect(cleared.run?.nextWake).toBe("");
    expect(cleared.run?.talkingReject).toBeUndefined();
  });

  it("field cannot set assumptions or risks", async () => {
    const stack = await habitatCore();
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        assumptions: ["field wrote this"],
      }),
    ).rejects.toBeInstanceOf(SurfaceViolationError);
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        assumptions: ["field wrote this"],
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    expect(stack.core.habitat.getRun(stack.tenantId)).toBeUndefined();

    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        risks: ["field wrote this"],
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
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
    expect(started.run?.nextWake).toBe("");
    await expect(
      stack.core.habitat.wake({
        kind: "field_ask",
        tenantId: stack.tenantId,
        pack: stack.pack,
        risks: ["field wrote this"],
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });
    expect(stack.core.habitat.getRun(stack.tenantId)?.nextWake).toBe("");

    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hk052-http-"));
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
        assumptions: ["field wrote this"],
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
      body: JSON.stringify({ risks: ["field wrote this"] }),
    });
    expect(blockedContinue.status).toBe(403);
    expect(((await blockedContinue.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    expect(core.habitat.getRun("t1")?.nextWake).toBe("");
  });

  it("mapper requires the same keys as the kernel schema", () => {
    try {
      cognitiveIntentFromUnknown({ pass: "talking", act: "follow_up", risks: [], nextWake: "" });
      expect.fail("missing assumptions must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: DECISION_ASSUMPTIONS, closed: true });
    }
    try {
      cognitiveIntentFromUnknown({
        pass: "talking",
        act: "follow_up",
        assumptions: [],
        nextWake: "",
      });
      expect.fail("missing risks must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: DECISION_RISKS, closed: true });
    }
    try {
      cognitiveIntentFromUnknown({
        pass: "talking",
        act: "follow_up",
        assumptions: [],
        risks: [],
      });
      expect.fail("missing nextWake without done must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: DECISION_NEXT_WAKE_OR_STOP, closed: true });
    }

    const done = cognitiveIntentFromUnknown({
      pass: "talking",
      act: "done",
      assumptions: [],
      risks: ["none"],
    });
    expect(done.act).toBe("done");
    expect(done.assumptions).toEqual([]);
    expect(done.risks).toEqual(["none"]);
    expect(done.nextWake).toBeUndefined();

    const scheduled = cognitiveIntentFromUnknown({
      pass: "talking",
      act: "follow_up",
      assumptions: ["continue"],
      risks: [],
      nextWake: "2026-08-17T15:00:00.000Z",
    });
    expect(scheduled.nextWake).toBe("2026-08-17T15:00:00.000Z");
    expect(scheduled.assumptions).toEqual(["continue"]);
    expect(scheduled.risks).toEqual([]);
  });
});
