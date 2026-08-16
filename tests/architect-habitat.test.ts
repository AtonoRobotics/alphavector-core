import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { architectSit } from "../src/auth/architect-habitat.js";
import { SurfaceViolationError } from "../src/errors.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import { reapHeldCoders } from "../src/habitat/index.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { AlphaVectorCore } from "../src/kernel.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  bootTestFieldCore,
  signedGenericPack,
} from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const servers: FieldHttpServer[] = [];

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
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk082-"));
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
  };
}

async function liveHttp(tenantId = "t1") {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-hk082-http-"));
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

describe("HK-082 Architect sits in the habitat", () => {
  it("keeps the RE fixture pin at 5091328 and does not invent a desktop name or vendor host", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const files = [
      "src/surfaces/architect.ts",
      "src/surfaces/types.ts",
      "src/auth/architect-habitat.ts",
      "src/cli.ts",
      "src/http/field-server.ts",
      "clients/field-linux/index.html",
      "clients/field-ios/Field/HomeView.swift",
      "clients/field-ios/Field/FieldAPI.swift",
      "clients/field-ios/Field/Models.swift",
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(src).not.toMatch(/Architect Desktop|Architect IDE|Architect Studio|Architect App/i);
      expect(src).not.toMatch(/api\.openai\.com|api\.anthropic\.com|anthropic\.com|openai\.azure\.com/);
      expect(src).not.toMatch(/Mission-Control|\bDesk\b|\bShape\b|\bPlay\b|\bPlant\b|\bHIL\b|\bThor\b/);
      expect(src).not.toMatch(/\bT0\b|\bT1\b|\bT2\b|\bT3\b/);
    }
    const seatSrc = readFileSync(path.join(process.cwd(), "src/surfaces/architect.ts"), "utf8");
    const typesSrc = readFileSync(path.join(process.cwd(), "src/surfaces/types.ts"), "utf8");
    expect(seatSrc).toMatch(/sit\(/);
    expect(seatSrc).not.toMatch(/grants:\s*true/);
    expect(seatSrc).not.toMatch(/fieldOwnerAuth:\s*false/);
    expect(typesSrc).toMatch(/ArchitectHabitatSeat/);
    expect(typesSrc).toMatch(/org:\s*AgentRecord/);
    expect(typesSrc).not.toMatch(/fieldOwnerAuth:\s*false/);
    expect(typesSrc).not.toMatch(/packLoad:\s*true/);
    const cliSrc = readFileSync(path.join(process.cwd(), "src/cli.ts"), "utf8");
    expect(cliSrc).toMatch(/architectSit/);
    expect(cliSrc).toMatch(/habitat reads live org, open runs, workers, grants, eval, isolation/);
    expect(cliSrc).not.toMatch(/write-habitat/);
  });

  it("Architect sits on live org, open runs, workers, grants, eval, isolation as records", async () => {
    const stack = await habitatCore();
    const orch = stack.agents.find((a) => a.isOrchestrator)!;
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
    stack.core.grants.write({
      actor: "architect",
      tenantId: stack.tenantId,
      agentId: orch.agentId,
      actionClass: "communicate",
      state: "authorized",
      bounds: { channels: ["email"] },
      owner: "architect-1",
      evidenceIds: ["ev1"],
      evalIds: ["eval1"],
      fieldNotice: "Follow-up emails will now send without asking. You can kill this.",
    });

    const seat = architectSit({
      tenantId: stack.tenantId,
      computerBaseDir: stack.computerBaseDir,
      surface: stack.core.architect,
      architectToken: stack.architectToken,
    });
    const home = stack.core.architect.home(stack.tenantId);
    expect(home).toEqual(seat);

    expect(seat.org.map((a) => a.name).sort()).toEqual(
      ["Orchestrator", "Researcher", "Reviewer", "Writer"].sort(),
    );
    expect(seat.org.every((a) => typeof a.agentId === "string" && a.agentId.length > 0)).toBe(true);
    expect(seat.runs).toHaveLength(1);
    expect(seat.runs[0]?.runId).toMatch(/^run_/);
    expect(seat.runs[0]?.goal).toBe("one goal");
    expect(seat.runs[0]?.status).not.toBe("completed");
    expect(seat.workers).toHaveLength(1);
    expect(seat.workers[0]?.isolation).toBe("trailer");
    expect(seat.workers[0]?.trailerPath).toContain("trailers");
    expect(seat.workers[0]?.workerId).toMatch(/^worker_/);
    expect(seat.grants).toHaveLength(1);
    expect(seat.grants[0]?.grantId).toMatch(/^grant_/);
    expect(seat.grants[0]?.actionClass).toBe("communicate");
    expect(seat.grants[0]?.state).toBe("authorized");
    expect(seat.eval.passed).toBe(true);
    expect(seat.eval.failed).toEqual([]);
    expect(seat.eval.fixtures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ev-independent",
          countsAsIndependentOutcome: true,
        }),
      ]),
    );
    expect(seat.isolation.isolation).toBe("trailer");
    expect(seat.isolation.exists).toBe(true);
    expect(seat.isolation.live).toBe(true);
    expect(seat.isolation.workerId).toBe(seat.workers[0]?.workerId);
    expect(typeof seat.grants).not.toBe("boolean");
    expect(typeof seat.eval).not.toBe("boolean");
    expect(seat).not.toHaveProperty("packLoad");
    expect(seat).not.toHaveProperty("fieldOwnerAuth");
  });

  it("field token cannot sit (SURFACE_VIOLATION) and CLI habitat is a read", async () => {
    const stack = await habitatCore();
    expect(() =>
      architectSit({
        tenantId: stack.tenantId,
        computerBaseDir: stack.computerBaseDir,
        surface: stack.core.architect,
        architectToken: stack.fieldToken,
      }),
    ).toThrow(SurfaceViolationError);
    expect(() =>
      architectSit({
        tenantId: stack.tenantId,
        computerBaseDir: stack.computerBaseDir,
        surface: stack.core.architect,
        architectToken: stack.fieldToken,
      }),
    ).toThrow(/SURFACE_VIOLATION|field token cannot sit|cannot bind/i);

    const empty = architectSit({
      tenantId: stack.tenantId,
      computerBaseDir: stack.computerBaseDir,
      surface: stack.core.architect,
      architectToken: stack.architectToken,
    });
    expect(empty.runs).toEqual([]);
    expect(empty.workers).toEqual([]);
    expect(empty.org.length).toBeGreaterThan(0);
    expect(empty.isolation.isolation).toBe("trailer");

    const cli = runArchitectCli(["architect", "habitat", "--tenant", stack.tenantId], {
      computerBaseDir: stack.computerBaseDir,
      architectToken: stack.architectToken,
    });
    expect(cli.status).toBe(0);
    const printed = JSON.parse(cli.stdout) as { org: unknown[]; isolation: { isolation: string } };
    expect(Array.isArray(printed.org)).toBe(true);
    expect(printed.org.length).toBeGreaterThan(0);
    expect(printed.isolation.isolation).toBe("trailer");

    const fieldCli = runArchitectCli(["architect", "habitat", "--tenant", stack.tenantId], {
      computerBaseDir: stack.computerBaseDir,
      architectToken: stack.fieldToken,
    });
    expect(fieldCli.status).not.toBe(0);
    expect(`${fieldCli.stdout}\n${fieldCli.stderr}`).toMatch(/cannot sit|field token|SURFACE_VIOLATION/i);
  });

  it("GET /architect/habitat is Architect-only; field home / Linux / iOS do not show the seat", async () => {
    const live = await liveHttp("hk082");
    const rec = live.core.records.put(live.tenantId, { type: "case", label: "Subject" });
    await live.core.habitat.wake(
      {
        kind: "field_start",
        tenantId: live.tenantId,
        pack: live.pack,
        goal: "http seat goal",
        recordId: rec.id,
      },
      { holdWorker: true },
    );

    const architectRes = await fetch(`${live.url}/architect/habitat`, {
      headers: { authorization: `Bearer ${live.architectToken}` },
    });
    expect(architectRes.status).toBe(200);
    const seat = (await architectRes.json()) as {
      org: Array<{ agentId: string }>;
      runs: Array<{ runId: string; goal: string }>;
      workers: Array<{ isolation: string; trailerPath: string }>;
      grants: unknown[];
      eval: { fixtures: unknown[] };
      isolation: { isolation: string };
    };
    expect(seat.org.length).toBeGreaterThan(0);
    expect(seat.runs[0]?.goal).toBe("http seat goal");
    expect(seat.workers[0]?.isolation).toBe("trailer");
    expect(Array.isArray(seat.grants)).toBe(true);
    expect(seat.eval.fixtures.length).toBeGreaterThan(0);
    expect(seat.isolation.isolation).toBe("trailer");

    const fieldRes = await fetch(`${live.url}/architect/habitat`, {
      headers: { authorization: `Bearer ${live.fieldToken}` },
    });
    expect(fieldRes.status).toBe(403);
    const fieldBody = (await fieldRes.json()) as { error: string };
    expect(fieldBody.error).toBe("SURFACE_VIOLATION");

    const missing = await fetch(`${live.url}/architect/habitat`);
    expect(missing.status).toBe(401);

    const fieldHome = await fetch(`${live.url}/field/home`, {
      headers: { authorization: `Bearer ${live.fieldToken}` },
    });
    expect(fieldHome.status).toBe(200);
    const home = (await fieldHome.json()) as { architectControls: unknown[] };
    expect(home.architectControls).toEqual([]);
    expect(JSON.stringify(home)).not.toMatch(/\/architect\/habitat/);

    const html = await (await fetch(live.url)).text();
    expect(html).not.toMatch(/architectControls|\/architect\/habitat|id="architect"/i);
    expect(html).not.toMatch(/pick a model|edit prompt|inspect temporal|configure tool/i);
    expect(html).toMatch(/Architect is not on this surface/);

    const iosHome = readFileSync(path.join(REPO_ROOT, "clients/field-ios/Field/HomeView.swift"), "utf8");
    const iosApi = readFileSync(path.join(REPO_ROOT, "clients/field-ios/Field/FieldAPI.swift"), "utf8");
    const iosModels = readFileSync(path.join(REPO_ROOT, "clients/field-ios/Field/Models.swift"), "utf8");
    for (const src of [iosHome, iosApi, iosModels]) {
      expect(src).not.toMatch(/architectControls|\/architect\/habitat|ArchitectHabitat/i);
      expect(src).not.toMatch(/Architect Desktop|Architect IDE/i);
    }
    expect(iosApi).toMatch(/\/field\/home/);

    const fieldSrc = readFileSync(path.join(process.cwd(), "src/http/field-server.ts"), "utf8");
    expect(fieldSrc).toMatch(/\/architect\/habitat/);
    expect(fieldSrc).toMatch(/A field token cannot sit in the habitat/);
    expect(fieldSrc).not.toMatch(/app\.post\(["']\/field\/architect/);
  });
});
