import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { architectBindAdapter } from "../src/auth/architect-adapter-bind.js";
import { architectDeploy, fieldDeploy, isFieldServeTheater } from "../src/auth/architect-deploy.js";
import { architectIssueFieldToken } from "../src/auth/architect-field-token.js";
import { ComputerHost } from "../src/computer/host.js";
import { computerRoot } from "../src/computer/paths.js";
import type { TenantComputer } from "../src/computer/types.js";
import { DeployIncompleteError, SurfaceViolationError } from "../src/errors.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import { adapterThink, DeepAgentsAdapter } from "../src/habitat/deep-agents.js";
import { deployFile, readTenantDeploy, saveDeployRecord } from "../src/habitat/deploy-store.js";
import { nowIso } from "../src/ids.js";
import type { AdapterInput, CognitiveIntent } from "../src/habitat/types.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { FieldClient } from "../src/http/field-client.js";
import { startFieldServe } from "../src/http/field-listen.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { AlphaVectorCore } from "../src/kernel.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  bootTestFieldCore,
  createOpenStart,
  signedGenericPack,
  withProductTrustEnv,
} from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const servers: FieldHttpServer[] = [];
const restoreProductEnv: Array<() => void> = [];

afterEach(async () => {
  while (restoreProductEnv.length) {
    restoreProductEnv.pop()?.();
  }
  while (servers.length) {
    await servers.pop()?.close();
  }
});

/** CI thinkFn that books retriever (no Hull spawn) so start/card/kill can hit the listen. */
function fieldReadyThink(input: AdapterInput): CognitiveIntent {
  const intent = adapterThink(input);
  if (intent.pass === "talking" && intent.act === "launch_worker") {
    return { ...intent, workerType: "retriever" };
  }
  return intent;
}

function occupyPort(host: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const held = net.createServer();
    held.once("error", reject);
    held.listen(0, host, () => {
      const addr = held.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () =>
          new Promise((res, rej) => {
            held.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

async function freePort(host: string): Promise<number> {
  const held = await occupyPort(host);
  await held.close();
  return held.port;
}

function runningStatus(tenantId: string, status: TenantComputer["status"] = "running"): TenantComputer {
  return {
    tenantId,
    status,
    imageId: "test",
    diskPath: "/tmp",
    sharedFilesystem: true,
  };
}

function attachComputer(
  core: AlphaVectorCore,
  tenantId: string,
  status: TenantComputer["status"] | "missing" = "running",
): void {
  if (status === "missing") return;
  core.computer = {
    driver: {
      status: async () => runningStatus(tenantId, status),
    },
  } as ComputerHost;
}

async function liveCore(opts?: {
  tenantId?: string;
  adapter?: ConstructorParameters<typeof AlphaVectorCore>[3];
  loadPack?: boolean;
  computer?: TenantComputer["status"] | "missing";
}) {
  const tenantId = opts?.tenantId ?? "live-1";
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-deploy-"));
  const { anchors, binding } = await signedGenericPack();
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir, opts?.adapter);
  if (opts?.loadPack !== false) {
    const loaded = core.packs.load({ tenantId, binding, actor: "architect" });
    if (!loaded.ok) throw new Error(loaded.message);
  }
  attachComputer(core, tenantId, opts?.computer ?? "running");
  const architect = architectIssueFieldToken({
    tenantId,
    principal: "architect",
    computerBaseDir,
  });
  const field = architectIssueFieldToken({
    tenantId,
    principal: "field",
    computerBaseDir,
    architectToken: architect.token,
  });
  return {
    tenantId,
    computerBaseDir,
    core,
    anchors,
    architectToken: architect.token,
    fieldToken: field.token,
  };
}

/** Live tenant that can serve field start/card/kill after architectDeploy listens. Not DryStem. */
async function liveFieldReady() {
  const stack = await liveCore({ adapter: new DeepAgentsAdapter(fieldReadyThink) });
  const pack = stack.core.packs.active(stack.tenantId);
  if (stack.core.agents.list(stack.tenantId).length === 0) {
    stack.core.agents.instantiateFromPack(pack, "architect");
  }
  stack.core.habitat.setPack(stack.tenantId, pack);
  architectBindAdapter({
    tenantId: stack.tenantId,
    modelId: "ci-double",
    computerBaseDir: stack.computerBaseDir,
    architectToken: stack.architectToken,
  });
  return stack;
}

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

describe("production deploy is Architect-only", () => {
  it("keeps the RE fixture pin at 5091328 and does not bake VEYRA or a vendor cloud", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const files = [
      "src/auth/architect-deploy.ts",
      "src/habitat/deploy-store.ts",
      "src/http/field-listen.ts",
      "src/http/field-server.ts",
      "src/cli.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(src).not.toMatch(/VEYRA/);
      expect(src).not.toMatch(/\bT0\b|\bT1\b|\bT2\b|\bT3\b/);
      expect(src).not.toMatch(/aws\.amazon|amazonaws|googleapis|cloud\.google|vercel|fly\.io|gcp\b/i);
      expect(src).not.toMatch(/\bDesk\b|\bShape\b|\bDirector\b|\bPlay\b|\bPlant\b|\bHIL\b|\bThor\b/);
    }
    const listen = readFileSync(path.join(REPO_ROOT, "src/http/field-listen.ts"), "utf8");
    expect(listen).toMatch(/isDeploy: false/);
    expect(listen).toMatch(/Not a production deploy/);
    expect(listen).not.toMatch(/architectDeploy|saveDeployRecord|deploy\.json/);
    const ios = readFileSync(path.join(REPO_ROOT, "clients/field-ios/Field/FieldAPI.swift"), "utf8");
    expect(ios).not.toMatch(/\/architect\/deploy|architectDeploy/);
    expect(ios).not.toMatch(/VEYRA/);
  });

  it("startFieldServe on 127.0.0.1 / port 0 / t1 is not a deploy", async () => {
    restoreProductEnv.push((await withProductTrustEnv()).restore);
    const started = await startFieldServe({
      tenantId: "t1",
      port: 0,
      host: "127.0.0.1",
    });
    servers.push(started.server);
    expect(started.isDeploy).toBe(false);
    expect(started.tenantId).toBe("t1");
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(isFieldServeTheater({ tenantId: started.tenantId, host: "127.0.0.1", port: 0 })).toBe(true);
    expect(readTenantDeploy(undefined, "t1")).toBeUndefined();
  });

  it("incomplete deploy (missing signed pack, Hull computer, or DATABASE_URL) is DEPLOY_INCOMPLETE", async () => {
    const noPack = await liveCore({ loadPack: false });
    await expect(
      architectDeploy({
        tenantId: noPack.tenantId,
        computerBaseDir: noPack.computerBaseDir,
        core: noPack.core,
        host: "0.0.0.0",
        port: 8443,
        architectToken: noPack.architectToken,
      }),
    ).rejects.toBeInstanceOf(DeployIncompleteError);
    try {
      await architectDeploy({
        tenantId: noPack.tenantId,
        computerBaseDir: noPack.computerBaseDir,
        core: noPack.core,
        host: "0.0.0.0",
        port: 8443,
        architectToken: noPack.architectToken,
      });
      throw new Error("expected missing signed pack to fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(DeployIncompleteError);
      expect((err as DeployIncompleteError).code).toBe("DEPLOY_INCOMPLETE");
      expect((err as DeployIncompleteError).closed).toBe(true);
      expect((err as DeployIncompleteError).message).toMatch(/Signed pack is missing/);
    }
    expect(readTenantDeploy(noPack.computerBaseDir, noPack.tenantId)).toBeUndefined();

    const noComputer = await liveCore({ computer: "missing" });
    await expect(
      architectDeploy({
        tenantId: noComputer.tenantId,
        computerBaseDir: noComputer.computerBaseDir,
        core: noComputer.core,
        host: "0.0.0.0",
        port: 8443,
        architectToken: noComputer.architectToken,
      }),
    ).rejects.toMatchObject({ code: "DEPLOY_INCOMPLETE", closed: true });
    expect(readTenantDeploy(noComputer.computerBaseDir, noComputer.tenantId)).toBeUndefined();

    const stopped = await liveCore({ computer: "stopped" });
    await expect(
      architectDeploy({
        tenantId: stopped.tenantId,
        computerBaseDir: stopped.computerBaseDir,
        core: stopped.core,
        host: "0.0.0.0",
        port: 8443,
        architectToken: stopped.architectToken,
      }),
    ).rejects.toMatchObject({ code: "DEPLOY_INCOMPLETE", message: expect.stringMatching(/Hull computer/) });

    const noDb = await liveCore();
    await expect(
      architectDeploy({
        tenantId: noDb.tenantId,
        computerBaseDir: noDb.computerBaseDir,
        core: noDb.core,
        host: "0.0.0.0",
        port: 8443,
        architectToken: noDb.architectToken,
        env: { ...process.env, DATABASE_URL: "" },
      }),
    ).rejects.toMatchObject({
      code: "DEPLOY_INCOMPLETE",
      closed: true,
      message: expect.stringMatching(/DATABASE_URL/),
    });
    expect(readTenantDeploy(noDb.computerBaseDir, noDb.tenantId)).toBeUndefined();
  });

  it("Architect deploy listens on the recorded host:port; a ledger write is not a deploy", async () => {
    const stack = await liveFieldReady();
    const port = await freePort("0.0.0.0");
    const { record, server } = await architectDeploy({
      tenantId: stack.tenantId,
      computerBaseDir: stack.computerBaseDir,
      core: stack.core,
      host: "0.0.0.0",
      port,
      architectToken: stack.architectToken,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "postgres://av:av@127.0.0.1:5432/av" },
    });
    servers.push(server);
    expect(record.deployedBy).toBe("architect");
    expect(record.tenantId).toBe("live-1");
    expect(record.host).toBe("0.0.0.0");
    expect(record.port).toBe(port);
    expect(record.computerStatus).toBe("running");
    expect(record.databaseConfigured).toBe(true);
    expect(record.packId).toBeTruthy();
    expect(record.packVersion).toBeTruthy();
    expect(readTenantDeploy(stack.computerBaseDir, stack.tenantId)).toEqual(record);
    expect(existsSync(computerRoot(stack.computerBaseDir, stack.tenantId).deployFile)).toBe(true);
    expect(isFieldServeTheater({ tenantId: record.tenantId, host: record.host, port: record.port })).toBe(
      false,
    );

    const field = new FieldClient(`http://${record.host}:${record.port}`, stack.fieldToken);
    const { journey } = await createOpenStart(field, "inquiry", "Work this inquiry");
    expect(journey.journeyKind).toBe("inquiry");
    const cards = await field.cards();
    expect(cards.length).toBeGreaterThan(0);
    await expect(field.kill("stop")).resolves.toEqual({ ok: true });

    const ghostPort = await freePort("0.0.0.0");
    const ghostDir = await mkdtemp(path.join(os.tmpdir(), "av-deploy-ghost-"));
    const ghost = {
      tenantId: "ghost-1",
      host: "0.0.0.0",
      port: ghostPort,
      packId: record.packId,
      packVersion: record.packVersion,
      computerStatus: "running" as const,
      databaseConfigured: true as const,
      deployedBy: "architect" as const,
      deployedAt: nowIso(),
    };
    saveDeployRecord(deployFile(ghostDir, ghost.tenantId), ghost);
    expect(readTenantDeploy(ghostDir, ghost.tenantId)).toEqual(ghost);
    await expect(
      fetch(`http://${ghost.host}:${ghost.port}/field/kill`, {
        method: "POST",
        headers: { authorization: `Bearer ${stack.fieldToken}`, "content-type": "application/json" },
        body: JSON.stringify({ reason: "ledger write is not a listen" }),
      }),
    ).rejects.toThrow();
  });

  it("listen failure is DEPLOY_INCOMPLETE and does not write deploy.json", async () => {
    const stack = await liveFieldReady();
    const held = await occupyPort("0.0.0.0");
    try {
      await expect(
        architectDeploy({
          tenantId: stack.tenantId,
          computerBaseDir: stack.computerBaseDir,
          core: stack.core,
          host: "0.0.0.0",
          port: held.port,
          architectToken: stack.architectToken,
          env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "postgres://av:av@127.0.0.1:5432/av" },
        }),
      ).rejects.toMatchObject({
        code: "DEPLOY_INCOMPLETE",
        closed: true,
        message: expect.stringMatching(/listen/i),
      });
      expect(readTenantDeploy(stack.computerBaseDir, stack.tenantId)).toBeUndefined();
    } finally {
      await held.close();
    }
  });

  it("Field cannot deploy (SURFACE_VIOLATION / 403)", async () => {
    const stack = await liveCore();
    expect(() => fieldDeploy()).toThrow(SurfaceViolationError);
    expect(() => fieldDeploy()).toThrow(/Field cannot deploy/);

    await expect(
      architectDeploy({
        tenantId: stack.tenantId,
        computerBaseDir: stack.computerBaseDir,
        core: stack.core,
        host: "0.0.0.0",
        port: 8443,
        architectToken: stack.fieldToken,
      }),
    ).rejects.toBeInstanceOf(SurfaceViolationError);

    const server = new FieldHttpServer({
      core: stack.core,
      pack: stack.core.packs.active(stack.tenantId),
      tenantId: stack.tenantId,
    });
    servers.push(server);
    const { url } = await server.listen(0, "127.0.0.1");

    const fieldRes = await fetch(`${url}/architect/deploy`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${stack.fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ host: "0.0.0.0", port: 8443 }),
    });
    expect(fieldRes.status).toBe(403);
    const fieldBody = (await fieldRes.json()) as { error: string };
    expect(fieldBody.error).toBe("SURFACE_VIOLATION");

    const fieldPath = await fetch(`${url}/field/deploy`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${stack.fieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ host: "0.0.0.0", port: 8443 }),
    });
    expect(fieldPath.status).toBe(403);
    expect(((await fieldPath.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");

    const cli = runArchitectCli(
      ["architect", "deploy", "--tenant", stack.tenantId, "--host", "0.0.0.0", "--port", "8443"],
      { computerBaseDir: stack.computerBaseDir, architectToken: stack.fieldToken },
    );
    expect(cli.status).not.toBe(0);
    expect(`${cli.stdout}\n${cli.stderr}`).toMatch(/cannot deploy|field token|SURFACE_VIOLATION/i);
  });

  it("DryStem / fixture pack / test boot is not a deploy", async () => {
    const dry = await liveCore({ adapter: { adapter: new DryStemAdapter() } });
    await expect(
      architectDeploy({
        tenantId: dry.tenantId,
        computerBaseDir: dry.computerBaseDir,
        core: dry.core,
        host: "0.0.0.0",
        port: 8443,
        architectToken: dry.architectToken,
      }),
    ).rejects.toMatchObject({
      code: "DEPLOY_INCOMPLETE",
      message: expect.stringMatching(/DryStem/),
    });
    expect(readTenantDeploy(dry.computerBaseDir, dry.tenantId)).toBeUndefined();

    const theater = await liveCore({ tenantId: "t1" });
    await expect(
      architectDeploy({
        tenantId: "t1",
        computerBaseDir: theater.computerBaseDir,
        core: theater.core,
        host: "127.0.0.1",
        port: 0,
        architectToken: theater.architectToken,
      }),
    ).rejects.toMatchObject({ code: "DEPLOY_INCOMPLETE" });
    expect(readTenantDeploy(theater.computerBaseDir, "t1")).toBeUndefined();

    await bootTestFieldCore("t1", { adapter: new DryStemAdapter() });
    expect(readTenantDeploy(undefined, "t1")).toBeUndefined();

    const { core } = await bootFieldCore("t1", await signedGenericPack());
    expect(core.habitat.cognitiveAdapterName()).not.toBe("dry-stem");
    expect(readTenantDeploy(undefined, "t1")).toBeUndefined();

    const bootSrc = readFileSync(path.join(REPO_ROOT, "src/http/field-boot.ts"), "utf8");
    expect(bootSrc).not.toMatch(/architectDeploy|saveDeployRecord|deploy\.json/);
    expect(bootSrc).toMatch(/DryStemAdapter is fixture-only/);
  });
});
