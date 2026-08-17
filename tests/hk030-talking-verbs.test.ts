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
  fixtureTypedDecision,
  reapHeldCoders,
  trailerBriefPath,
  WAKE_KINDS,
} from "../src/habitat/index.js";
import type { AdapterInput, CognitiveAdapter, CognitiveIntent, WorkerBrief } from "../src/habitat/types.js";
import type { FixtureDecisionInput } from "../src/habitat/typed-decision.js";
import { FieldClient } from "../src/http/field-client.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { AlphaVectorCore } from "../src/kernel.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  bootTestFieldCore,
  REPO_ROOT,
  signedGenericPack,
} from "./helpers.js";
import { closeWorldHttp, useWorldHttp } from "./world-double.js";

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
  await closeWorldHttp();
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function scheduleOnStart(due: string): CognitiveAdapter {
  return {
    name: "hk030-schedule",
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

function talkingScript(script: {
  onTalking?: (input: AdapterInput) => FixtureDecisionInput | undefined;
  captureWorker?: WorkerBrief[];
}): CognitiveAdapter {
  return {
    name: "hk030-script",
    owns: ["think"],
    requiresBind: false,
    think(input) {
      if (input.pass === "worker") {
        if (input.brief) script.captureWorker?.push(input.brief);
        return dryThink(input);
      }
      const talking = script.onTalking?.(input);
      return talking ? fixtureTypedDecision(talking) : dryThink(input);
    },
  };
}

async function habitatCore(adapter: CognitiveAdapter = new DryStemAdapter()) {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk030-"));
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

describe("HK-030 talking kernel verbs", () => {
  it("keeps the RE fixture pin at 5091328 and does not rewrite field home or invent brand", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const source = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(source).toMatch(/5091328a2a5d4a9429ec65fef6da5683ede1cac9/);

    const fieldHome = readFileSync(path.join(process.cwd(), "src/surfaces/field.ts"), "utf8");
    expect(fieldHome).toMatch(/home\(tenantId: string, pack\?: LoadedPack\): FieldHome/);
    expect(fieldHome).toMatch(/architectControls: \[\]/);
    expect(fieldHome).not.toMatch(/write_brief|steer|HK-030|pickAgent/);
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
    expect(kernelSrc).toMatch(/ADAPTER_UNBOUND/);
    expect(kernelSrc).toMatch(/writeWorkerBrief/);
    expect(kernelSrc).toMatch(/actSteer/);
    expect(kernelSrc).toMatch(/actReport/);
    expect(kernelSrc).not.toMatch(/nextWakeTicker|setInterval\([^)]*nextWake/);
    expect((kernelSrc.match(/setInterval\(/g) ?? []).length).toBe(1);

    const adapterSrc = readFileSync(path.join(process.cwd(), "src/habitat/adapter.ts"), "utf8");
    expect(adapterSrc).toMatch(/readonly name = "dry-stem"/);
    expect(adapterSrc).not.toMatch(/write_brief|steer|report/);
    expect(adapterSrc).not.toMatch(/wake\(|startDueTicker/);

    expect(WAKE_KINDS).toEqual([...CLOSED_V1]);
    expect(WAKE_KINDS).not.toContain("card_decided");
    expect(WAKE_KINDS).not.toContain("connector_event");
    expect(WAKE_KINDS).not.toContain("next_wake");
    expect(WAKE_KINDS).not.toContain("steer");
    expect(WAKE_KINDS).not.toContain("brief");
  });

  it("existing acts still work: launch_worker, propose_effect → card, follow_up, done, nextWake set/fired", async () => {
    const due = "2026-08-17T12:00:00.000Z";
    const started = await habitatCore(scheduleOnStart(due));
    const talking = await started.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: started.tenantId,
        pack: started.pack,
        goal: "one goal",
        recordId: started.record.id,
      },
      { until: "talking" },
    );
    expect(talking.run?.status).toBe("talking");
    expect(talking.run?.nextWake).toBe(due);
    expect(talking.launchedWorker).toBe(false);
    expect(talking.talkingDidHeavyWork).toBe(false);

    const launched = await started.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: started.tenantId,
        pack: started.pack,
        goal: "one goal",
        recordId: started.record.id,
      },
      { holdWorker: true },
    );
    expect(launched.launchedWorker).toBe(true);
    expect(launched.run?.workerType).toBe("coder");
    expect(launched.run?.workers).toEqual([launched.run?.workerId]);
    expect(launched.cardId).toMatch(/^card_/);
    expect(launched.run?.status).toBe("awaiting_card");
    expect(launched.talkingDidHeavyWork).toBe(false);

    await started.core.habitat.advanceClock(due);
    expect(started.core.habitat.getRun(started.tenantId)?.nextWake).toBe("");
    expect(started.core.habitat.listWakes(started.tenantId).some((w) => w.kind === "field_continue")).toBe(true);

    const follow = await habitatCore({
      name: "hk030-follow",
      owns: ["think"],
      requiresBind: false,
      think(input) {
        if (input.pass === "talking" && input.event.kind === "worker_done") {
          return fixtureTypedDecision({ pass: "talking", act: "follow_up" });
        }
        return dryThink(input);
      },
    });
    const first = await follow.core.habitat.wake({
      kind: "field_start",
      tenantId: follow.tenantId,
      pack: follow.pack,
      goal: "one goal",
      recordId: follow.record.id,
    });
    const firstWorker = first.run!.workerId;
    const continued = await follow.core.habitat.wake({
      kind: "worker_done",
      tenantId: follow.tenantId,
      pack: follow.pack,
    });
    expect(continued.launchedWorker).toBe(true);
    expect(continued.run?.runId).toBe(first.run?.runId);
    expect(continued.run?.workerId).toBeDefined();
    expect(continued.run?.workerId).not.toBe(firstWorker);
    expect(continued.run?.workerType).toBe("coder");
    expect(continued.run?.status).not.toBe("completed");

    const doneStack = await habitatCore();
    const working = await doneStack.core.habitat.wake({
      kind: "field_start",
      tenantId: doneStack.tenantId,
      pack: doneStack.pack,
      goal: "one goal",
      recordId: doneStack.record.id,
    });
    const finished = await doneStack.core.habitat.wake({
      kind: "worker_done",
      tenantId: doneStack.tenantId,
      pack: doneStack.pack,
    });
    expect(finished.run?.runId).toBe(working.run?.runId);
    expect(finished.run?.status).toBe("completed");
    expect(finished.talkingDidHeavyWork).toBe(false);
  });

  it("a validated talking decision writes a kernel brief artifact the worker pass reads", async () => {
    const seen: WorkerBrief[] = [];
    const stack = await habitatCore(
      talkingScript({
        onTalking(input) {
          if (input.event.kind === "field_start") {
            return {
              pass: "talking",
              act: "launch_worker",
              workerType: "coder",
              brief: "do the booked work",
            };
          }
          return dryThink(input);
        },
        captureWorker: seen,
      }),
    );
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
    expect(started.launchedWorker).toBe(true);
    const workerId = started.run!.workerId!;
    expect(started.run?.workers).toEqual([workerId]);

    expect(seen).toHaveLength(1);
    const brief = seen[0]!;
    expect(brief.writtenBy).toBe("kernel");
    expect(brief.workerId).toBe(workerId);
    expect(brief.runId).toBe(started.run?.runId);
    expect(brief.body).toBe("do the booked work");
    expect(existsSync(brief.path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(brief.path, "utf8")) as {
      body: string;
      writtenBy: string;
      workerId: string;
    };
    expect(onDisk.body).toBe("do the booked work");
    expect(onDisk.writtenBy).toBe("kernel");
    expect(onDisk.workerId).toBe(workerId);

    const worker = stack.core.habitat.activeWorker(stack.tenantId)!;
    const trailerFile = trailerBriefPath(worker.trailerPath);
    expect(existsSync(trailerFile)).toBe(true);
    expect(JSON.parse(readFileSync(trailerFile, "utf8")).body).toBe("do the booked work");

    const loaded = stack.core.habitat.workerBrief(stack.tenantId);
    expect(loaded?.body).toBe("do the booked work");
    expect(loaded?.path).toBe(brief.path);
    expect(loaded?.workerId).toBe(workerId);

    const writeThenLaunch = await habitatCore(
      talkingScript({
        onTalking(input) {
          if (input.pass === "talking" && input.event.kind === "field_start") {
            return { pass: "talking", act: "write_brief", brief: "pending then launch" };
          }
          if (input.pass === "talking" && input.event.kind === "field_continue") {
            return { pass: "talking", act: "launch_worker", workerType: "coder" };
          }
          return dryThink(input);
        },
        captureWorker: [],
      }),
    );
    const pending = await writeThenLaunch.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: writeThenLaunch.tenantId,
        pack: writeThenLaunch.pack,
        goal: "one goal",
        recordId: writeThenLaunch.record.id,
      },
      { until: "talking" },
    );
    expect(pending.launchedWorker).toBe(false);
    expect(writeThenLaunch.core.habitat.workerBrief(writeThenLaunch.tenantId)?.body).toBe("pending then launch");

    const captured: WorkerBrief[] = [];
    const launchAfter = await habitatCore(
      talkingScript({
        onTalking(input) {
          if (input.event.kind === "field_start") {
            return { pass: "talking", act: "write_brief", brief: "pending then launch" };
          }
          if (input.event.kind === "field_continue") {
            return { pass: "talking", act: "launch_worker", workerType: "coder" };
          }
          return dryThink(input);
        },
        captureWorker: captured,
      }),
    );
    await launchAfter.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: launchAfter.tenantId,
        pack: launchAfter.pack,
        goal: "one goal",
        recordId: launchAfter.record.id,
      },
      { until: "talking" },
    );
    await launchAfter.core.habitat.wake(
      {
        kind: "field_continue",
        tenantId: launchAfter.tenantId,
        pack: launchAfter.pack,
      },
      { holdWorker: true },
    );
    expect(captured[0]?.body).toBe("pending then launch");
    expect(existsSync(captured[0]!.path)).toBe(true);
    expect(captured[0]?.writtenBy).toBe("kernel");
  });

  it("talking can steer the same booked worker; field cannot pickAgent or write a brief", async () => {
    const seen: WorkerBrief[] = [];
    const stack = await habitatCore(
      talkingScript({
        onTalking(input) {
          if (input.event.kind === "field_continue") {
            return { pass: "talking", act: "steer", brief: "change course" };
          }
          return dryThink(input);
        },
        captureWorker: seen,
      }),
    );
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
    const workerId = started.run!.workerId!;
    expect(started.run?.workers).toEqual([workerId]);
    expect(started.run?.workerType).toBe("coder");
    const firstBriefs = seen.length;

    const steered = await stack.core.habitat.wake(
      {
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
      },
      { holdWorker: true },
    );
    expect(steered.launchedWorker).toBe(false);
    expect(steered.run?.workerId).toBe(workerId);
    expect(steered.run?.workers).toEqual([workerId]);
    expect(steered.run?.workerType).toBe("coder");
    expect(stack.core.habitat.listWorkers(stack.tenantId)).toHaveLength(1);
    expect(stack.core.habitat.activeWorker(stack.tenantId)?.type).toBe("coder");
    expect(seen.length).toBeGreaterThan(firstBriefs);
    expect(seen.at(-1)?.body).toBe("change course");
    expect(seen.at(-1)?.workerId).toBe(workerId);
    expect(seen.at(-1)?.writtenBy).toBe("kernel");
    expect(existsSync(seen.at(-1)!.path)).toBe(true);

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
    await expect(
      stack.core.habitat.wake({
        kind: "field_continue",
        tenantId: stack.tenantId,
        pack: stack.pack,
        brief: "field brief",
      }),
    ).rejects.toBeInstanceOf(SurfaceViolationError);
    await expect(
      stack.core.habitat.wake({
        kind: "field_start",
        tenantId: stack.tenantId,
        pack: stack.pack,
        goal: "one goal",
        recordId: stack.record.id,
        steer: "field steer",
      }),
    ).rejects.toMatchObject({ code: "SURFACE_VIOLATION" });

    const dir = await mkdtemp(path.join(os.tmpdir(), "av-hk030-http-"));
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
    await field.start(kind, "http goal", record.id);

    for (const body of [{ brief: "field brief" }, { steer: "field steer" }, { report: "field report" }]) {
      const res = await fetch(`${url}/field/continue`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fieldToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    }
    const pick = await fetch(`${url}/field/continue`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ pickAgent: "Follow-up" }),
    });
    expect(pick.status).toBe(400);
    expect(((await pick.json()) as { error: string }).error).toBe("FIELD_CANNOT_PICK_AGENT");
    const noRoute = await fetch(`${url}/field/pickAgent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agent: "coder" }),
    });
    expect(noRoute.status).toBe(404);
  });

  it("talking can report without executing an external effect", async () => {
    const world = await useWorldHttp();
    const stack = await habitatCore(
      talkingScript({
        onTalking() {
          return { pass: "talking", act: "report", body: "status only" };
        },
      }),
    );
    const reported = await stack.core.habitat.wake({
      kind: "field_start",
      tenantId: stack.tenantId,
      pack: stack.pack,
      goal: "one goal",
      recordId: stack.record.id,
    });
    expect(reported.report).toEqual({
      body: "status only",
      executedEffect: false,
      cardRequired: false,
    });
    expect(reported.effect).toBeUndefined();
    expect(reported.cardId).toBeUndefined();
    expect(reported.launchedWorker).toBe(false);
    expect(reported.talkingDidHeavyWork).toBe(false);
    expect(reported.run?.status).toBe("talking");
    expect(reported.run?.pendingCardId).toBeUndefined();
    expect(stack.core.habitat.activeWorker(stack.tenantId)).toBeUndefined();
    expect(world.requests).toHaveLength(0);
    expect(stack.core.store.actions.some((a) => a.status === "executed")).toBe(false);
    expect(stack.core.cards.fieldInbox(stack.tenantId)).toHaveLength(0);
  });

  it("talking stays thin: no heavy work, no world call except kernel verbs", async () => {
    const world = await useWorldHttp();
    const heavy = await habitatCore({
      name: "hk030-heavy",
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
    expect(world.requests).toHaveLength(0);
    expect(heavy.core.cards.fieldInbox(heavy.tenantId)).toHaveLength(0);

    const briefOnly = await habitatCore(
      talkingScript({
        onTalking() {
          return { pass: "talking", act: "write_brief", brief: "notes only" };
        },
      }),
    );
    const wrote = await briefOnly.core.habitat.wake({
      kind: "field_start",
      tenantId: briefOnly.tenantId,
      pack: briefOnly.pack,
      goal: "one goal",
      recordId: briefOnly.record.id,
    });
    expect(wrote.talkingDidHeavyWork).toBe(false);
    expect(wrote.launchedWorker).toBe(false);
    expect(wrote.effect).toBeUndefined();
    expect(wrote.cardId).toBeUndefined();
    expect(world.requests).toHaveLength(0);

    const badBrief = await habitatCore({
      name: "hk030-bad-brief",
      owns: ["think"],
      requiresBind: false,
      think(input) {
        const intent = dryThink(input) as CognitiveIntent & { brief?: unknown };
        if (input.pass === "talking") intent.brief = 12;
        return intent as CognitiveIntent;
      },
    });
    await expect(
      badBrief.core.habitat.wake(
        {
          kind: "field_start",
          tenantId: badBrief.tenantId,
          pack: badBrief.pack,
          goal: "one goal",
          recordId: badBrief.record.id,
        },
        { until: "talking" },
      ),
    ).rejects.toMatchObject({ code: "BRIEF_INVALID", closed: true });
    expect(badBrief.core.habitat.workerBrief(badBrief.tenantId)).toBeUndefined();
    expect(existsSync(computerRoot(badBrief.computerBaseDir, badBrief.tenantId).briefsDir)).toBe(false);
  });

  it("unbound adapter stays ADAPTER_UNBOUND; DryStem is fixture-only", async () => {
    const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk030-unbound-"));
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
});
