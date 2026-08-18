import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { architectBindAdapter, architectEditAdapterBind } from "../src/auth/architect-adapter-bind.js";
import { architectWriteAdapterAggregator } from "../src/auth/architect-adapter-aggregator.js";
import { architectWriteAdapterRouter } from "../src/auth/architect-adapter-router.js";
import { architectSit } from "../src/auth/architect-habitat.js";
import { computerRoot } from "../src/computer/paths.js";
import { SurfaceViolationError } from "../src/errors.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import { loadAdapterAggregator } from "../src/habitat/adapter-aggregator.js";
import { loadAdapterBind, loadAdapterBindStore } from "../src/habitat/adapter-bind.js";
import { loadAdapterCredentials } from "../src/habitat/adapter-credentials.js";
import { loadAdapterRouter } from "../src/habitat/adapter-router.js";
import {
  GITHUB_CLIENT_ID,
  GITHUB_DEVICE_GRANT,
  GITHUB_DEVICE_URL,
  GITHUB_TOKEN_URL,
} from "../src/habitat/connector-auth.js";
import { loadConnectorBindStore } from "../src/habitat/connector-bind.js";
import { loadConnectorCredentialsStore } from "../src/habitat/connector-credentials.js";
import { resetVendorFetch, setVendorFetch } from "../src/habitat/vendor-fetch.js";
import {
  CODEX_CLIENT_ID,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_ISSUER,
  CODEX_OAUTH_TOKEN_PATH,
  CODEX_TOKEN_POLL_PATH,
  CODEX_USERCODE_PATH,
  CODEX_VERIFICATION_PATH,
  GLM_AUTHORIZE_URL,
  GLM_CLIENT_ID,
  GLM_DEAD_CLI_INIT,
  GLM_REDIRECT_URI,
  GLM_TOKEN_URL,
  GROK_CLIENT_ID,
  GROK_DEVICE_GRANT,
  GROK_DEVICE_PATH,
  GROK_ISSUER,
  GROK_TOKEN_PATH,
} from "../src/habitat/vendor-login.js";
import { architectHabitatPageHtml } from "../src/http/architect-habitat-page.js";
import {
  HABITAT_CONNECTORS,
  HABITAT_PROVIDERS,
  isAdminAddPath,
  modelIdForBind,
  visibleAttachFields,
} from "../src/http/architect-habitat-wizard.js";
import { reapHeldCoders } from "../src/habitat/index.js";
import { resolveVendorBaseUrl } from "../src/habitat/vendor-think.js";
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
  resetVendorFetch();
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
      "src/http/architect-habitat-page.ts",
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
    expect(fieldSrc).toMatch(/architectBindAdapter\(/);
    expect(fieldSrc).toMatch(/architectWriteAdapterCredentials\(/);
    expect(fieldSrc).toMatch(/architectBindConnector\(/);
    expect(fieldSrc).toMatch(/architectWriteConnectorCredentials\(/);
    expect(fieldSrc).not.toMatch(/app\.post\(["']\/field\/architect/);
    expect(fieldSrc).not.toMatch(/gpt-|claude-|api\.openai\.com|api\.anthropic\.com|OPENAI_API_KEY|AV_NO_VENDOR/);
  });

  it("Architect token binds via habitat HTTP; field token is SURFACE_VIOLATION; disk matches CLI", async () => {
    const live = await liveHttp("wizard");
    const auth = { authorization: `Bearer ${live.architectToken}`, "content-type": "application/json" };
    const modelId = "ci-double";
    const vendorBaseUrl = "http://127.0.0.1:9";
    const apiKey = "av-wizard-key";
    const connectorId = "world";
    const baseUrl = "http://127.0.0.1:8";
    const secret = "av-wizard-secret";

    const htmlRes = await fetch(`${live.url}/architect/habitat`, {
      headers: { authorization: `Bearer ${live.architectToken}`, accept: "text/html" },
    });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toMatch(/text\/html/);
    const html = await htmlRes.text();
    expect(html).toMatch(/Architect sits in the habitat/);
    expect(html).toMatch(/id="model-id"/);
    expect(html).toMatch(/\/architect\/bind-adapter/);
    expect(html).not.toMatch(/Architect Desktop|Architect IDE|Architect Studio|Architect App/i);
    expect(html).not.toMatch(/gpt-|claude-|api\.openai\.com|api\.anthropic\.com|OPENAI_API_KEY/);

    const bindAdapter = await fetch(`${live.url}/architect/bind-adapter`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ modelId, vendorBaseUrl }),
    });
    expect(bindAdapter.status).toBe(201);
    const boundAdapter = (await bindAdapter.json()) as { modelId: string; boundBy: string };
    expect(boundAdapter.modelId).toBe(modelId);
    expect(boundAdapter.boundBy).toBe("architect");

    const setKey = await fetch(`${live.url}/architect/set-adapter-credentials`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ apiKey }),
    });
    expect(setKey.status).toBe(201);
    expect(((await setKey.json()) as { writtenBy: string }).writtenBy).toBe("architect");

    const bindConnector = await fetch(`${live.url}/architect/bind-connector`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ connectorId, baseUrl, requiresCredentials: true }),
    });
    expect(bindConnector.status).toBe(201);
    const boundConnector = (await bindConnector.json()) as { connectorId: string; boundBy: string };
    expect(boundConnector.connectorId).toBe(connectorId);
    expect(boundConnector.boundBy).toBe("architect");

    const setSecret = await fetch(`${live.url}/architect/set-connector-credentials`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ connectorId, secret }),
    });
    expect(setSecret.status).toBe(201);
    expect(((await setSecret.json()) as { writtenBy: string }).writtenBy).toBe("architect");

    const fieldAuth = { authorization: `Bearer ${live.fieldToken}`, "content-type": "application/json" };
    for (const route of [
      "/architect/bind-adapter",
      "/architect/set-adapter-credentials",
      "/architect/start-subscription-auth",
      "/architect/complete-subscription-auth",
      "/architect/start-connector-auth",
      "/architect/complete-connector-auth",
      "/architect/bind-connector",
      "/architect/set-connector-credentials",
    ]) {
      const denied = await fetch(`${live.url}${route}`, {
        method: "POST",
        headers: fieldAuth,
        body: JSON.stringify({ modelId, apiKey, connectorId, secret }),
      });
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    }
    const fieldHtml = await fetch(`${live.url}/architect/habitat`, {
      headers: { authorization: `Bearer ${live.fieldToken}`, accept: "text/html" },
    });
    expect(fieldHtml.status).toBe(403);
    expect(((await fieldHtml.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");

    const fieldHome = await fetch(`${live.url}/field/home`, {
      headers: { authorization: `Bearer ${live.fieldToken}` },
    });
    const home = (await fieldHome.json()) as { architectControls: unknown[] };
    expect(home.architectControls).toEqual([]);
    expect(JSON.stringify(home)).not.toMatch(/\/architect\/bind-adapter|model-id|vendor-base-url/i);

    const fieldPage = await (await fetch(live.url)).text();
    expect(fieldPage).not.toMatch(/\/architect\/bind-adapter|id="model-id"|Write adapter/i);
    expect(fieldPage).toMatch(/Architect is not on this surface/);

    const cliDir = await mkdtemp(path.join(os.tmpdir(), "av-hk082-cli-"));
    const { core: cliCore } = await bootTestFieldCore("wizard", {
      computerBaseDir: cliDir,
      adapter: new DryStemAdapter(),
    });
    const cliArchitect = cliCore.fieldTokens.issue({ tenantId: "wizard", principal: "architect" });
    const cli = runArchitectCli(
      [
        "architect",
        "bind-adapter",
        "--tenant",
        "wizard",
        "--model",
        modelId,
        "--vendor-base-url",
        vendorBaseUrl,
        "--architect-token",
        cliArchitect.token,
      ],
      { computerBaseDir: cliDir },
    );
    expect(cli.status).toBe(0);
    runArchitectCli(
      [
        "architect",
        "set-adapter-credentials",
        "--tenant",
        "wizard",
        "--api-key",
        apiKey,
        "--architect-token",
        cliArchitect.token,
      ],
      { computerBaseDir: cliDir },
    );
    runArchitectCli(
      [
        "architect",
        "bind-connector",
        "--tenant",
        "wizard",
        "--connector-id",
        connectorId,
        "--base-url",
        baseUrl,
        "--requires-credentials",
        "--architect-token",
        cliArchitect.token,
      ],
      { computerBaseDir: cliDir },
    );
    runArchitectCli(
      [
        "architect",
        "set-connector-credentials",
        "--tenant",
        "wizard",
        "--connector-id",
        connectorId,
        "--secret",
        secret,
        "--architect-token",
        cliArchitect.token,
      ],
      { computerBaseDir: cliDir },
    );

    const httpPaths = computerRoot(live.computerBaseDir, live.tenantId);
    const cliPaths = computerRoot(cliDir, "wizard");
    for (const file of [
      httpPaths.adapterBindFile,
      httpPaths.adapterCredentialsFile,
      httpPaths.connectorBindFile,
      httpPaths.connectorCredentialsFile,
    ]) {
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(path.join(httpPaths.disk, "adapter-bind.json"))).toBe(false);
    expect(existsSync(path.join(httpPaths.disk, "adapter-credentials.json"))).toBe(false);
    expect(existsSync(path.join(httpPaths.disk, "connector-bind.json"))).toBe(false);
    expect(existsSync(path.join(httpPaths.disk, "connector-credentials.json"))).toBe(false);

    const httpBind = loadAdapterBind(httpPaths.adapterBindFile)!;
    const cliBind = loadAdapterBind(cliPaths.adapterBindFile)!;
    expect(httpBind.boundBy).toBe("architect");
    expect(cliBind.boundBy).toBe("architect");
    expect(httpBind.modelId).toBe(cliBind.modelId);
    expect(httpBind.vendorBaseUrl).toBe(cliBind.vendorBaseUrl);
    expect(httpBind).not.toHaveProperty("apiKey");

    const httpCreds = loadAdapterCredentials(httpPaths.adapterCredentialsFile)!;
    const cliCreds = loadAdapterCredentials(cliPaths.adapterCredentialsFile)!;
    expect(httpCreds.writtenBy).toBe("architect");
    expect(cliCreds.writtenBy).toBe("architect");
    expect(httpCreds.apiKey).toBe(cliCreds.apiKey);

    const httpConn = loadConnectorBindStore(httpPaths.connectorBindFile).connectors[0]!;
    const cliConn = loadConnectorBindStore(cliPaths.connectorBindFile).connectors[0]!;
    expect(httpConn.boundBy).toBe("architect");
    expect(cliConn.boundBy).toBe("architect");
    expect(httpConn.connectorId).toBe(cliConn.connectorId);
    expect(httpConn.baseUrl).toBe(cliConn.baseUrl);
    expect(httpConn.requiresCredentials).toBe(true);
    expect(httpConn).not.toHaveProperty("secret");

    const httpSecret = loadConnectorCredentialsStore(httpPaths.connectorCredentialsFile).credentials[0]!;
    const cliSecret = loadConnectorCredentialsStore(cliPaths.connectorCredentialsFile).credentials[0]!;
    expect(httpSecret.writtenBy).toBe("architect");
    expect(cliSecret.writtenBy).toBe("architect");
    expect(httpSecret.secret).toBe(cliSecret.secret);

    const inProcess = architectBindAdapter({
      tenantId: "in-process",
      modelId,
      vendorBaseUrl,
      computerBaseDir: cliDir,
      architectToken: cliCore.fieldTokens.issue({ tenantId: "in-process", principal: "architect" }).token,
    });
    expect(inProcess.boundBy).toBe("architect");
    expect(inProcess.modelId).toBe(httpBind.modelId);
  });

  it("unauthenticated Accept: text/html serves the inert wizard shell; JSON and writes stay gated", async () => {
    const live = await liveHttp("shell");
    const browserAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    const browser = await fetch(`${live.url}/architect/habitat`, {
      headers: { accept: browserAccept },
    });
    expect(browser.status).toBe(200);
    expect(browser.headers.get("content-type")).toMatch(/text\/html/);
    expect(browser.headers.get("set-cookie")).toBeNull();
    const shell = await browser.text();
    expect(shell).toMatch(/<!DOCTYPE html>/i);
    expect(shell).toMatch(/Architect sits in the habitat/);
    expect(shell).toMatch(/id="token"/);
    expect(shell).toMatch(/Issued Architect credential/);
    expect(shell).toMatch(/authorization:\s*"Bearer " \+ token\(\)/);
    expect(shell).not.toMatch(/document\.cookie|localStorage|sessionStorage/i);
    expect(shell).not.toMatch(/[?&]token=/);
    expect(shell).not.toContain(live.architectToken);
    expect(shell).not.toContain(live.fieldToken);
    expect(shell).not.toMatch(/value="[^"]+"/);

    const jsonMissing = await fetch(`${live.url}/architect/habitat`, {
      headers: { accept: "application/json" },
    });
    expect(jsonMissing.status).toBe(401);
    expect(jsonMissing.headers.get("content-type")).toMatch(/application\/json/);
    expect(((await jsonMissing.json()) as { error: string }).error).toBe("UNAUTHORIZED");

    const queryToken = await fetch(`${live.url}/architect/habitat?token=${encodeURIComponent(live.architectToken)}`, {
      headers: { accept: "application/json" },
    });
    expect(queryToken.status).toBe(401);
    expect(((await queryToken.json()) as { error: string }).error).toBe("UNAUTHORIZED");

    const cookieToken = await fetch(`${live.url}/architect/habitat`, {
      headers: { accept: "application/json", cookie: `token=${live.architectToken}` },
    });
    expect(cookieToken.status).toBe(401);
    expect(((await cookieToken.json()) as { error: string }).error).toBe("UNAUTHORIZED");

    const queryHtml = await fetch(`${live.url}/architect/habitat?token=${encodeURIComponent(live.architectToken)}`, {
      headers: { accept: "text/html" },
    });
    expect(queryHtml.status).toBe(200);
    const queryHtmlBody = await queryHtml.text();
    expect(queryHtmlBody).toMatch(/text\/html|Architect sits in the habitat/);
    expect(queryHtmlBody).not.toContain(live.architectToken);
    expect(queryHtml.headers.get("set-cookie")).toBeNull();

    const fieldJson = await fetch(`${live.url}/architect/habitat`, {
      headers: { authorization: `Bearer ${live.fieldToken}`, accept: "application/json" },
    });
    expect(fieldJson.status).toBe(403);
    expect(((await fieldJson.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");

    const fieldWrite = await fetch(`${live.url}/architect/bind-adapter`, {
      method: "POST",
      headers: { authorization: `Bearer ${live.fieldToken}`, "content-type": "application/json" },
      body: JSON.stringify({ modelId: "ci-double" }),
    });
    expect(fieldWrite.status).toBe(403);
    expect(((await fieldWrite.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    const fieldSub = await fetch(`${live.url}/architect/start-subscription-auth`, {
      method: "POST",
      headers: { authorization: `Bearer ${live.fieldToken}`, "content-type": "application/json" },
      body: JSON.stringify({ providerId: "sub-codex" }),
    });
    expect(fieldSub.status).toBe(403);
    expect(((await fieldSub.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");

    const writeMissing = await fetch(`${live.url}/architect/bind-adapter`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "ci-double" }),
    });
    expect(writeMissing.status).toBe(401);
    expect(((await writeMissing.json()) as { error: string }).error).toBe("UNAUTHORIZED");

    const writeOk = await fetch(`${live.url}/architect/bind-adapter`, {
      method: "POST",
      headers: { authorization: `Bearer ${live.architectToken}`, "content-type": "application/json" },
      body: JSON.stringify({ modelId: "ci-double" }),
    });
    expect(writeOk.status).toBe(201);
    expect(((await writeOk.json()) as { boundBy: string }).boundBy).toBe("architect");
  });

  it("HTTP bind without a model or vendor URL stays fail-closed; no hardcoded vendor", async () => {
    const live = await liveHttp("unbound");
    const missing = await fetch(`${live.url}/architect/bind-adapter`, {
      method: "POST",
      headers: { authorization: `Bearer ${live.architectToken}`, "content-type": "application/json" },
      body: JSON.stringify({ modelId: "" }),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe("ADAPTER_BIND_REQUIRED");
    expect(loadAdapterBind(computerRoot(live.computerBaseDir, live.tenantId).adapterBindFile)).toBeUndefined();

    const bound = await fetch(`${live.url}/architect/bind-adapter`, {
      method: "POST",
      headers: { authorization: `Bearer ${live.architectToken}`, "content-type": "application/json" },
      body: JSON.stringify({ modelId: "ci-double" }),
    });
    expect(bound.status).toBe(201);
    const record = loadAdapterBind(computerRoot(live.computerBaseDir, live.tenantId).adapterBindFile)!;
    expect(record.modelId).toBe("ci-double");
    expect(record.vendorBaseUrl).toBeUndefined();
    expect(record.boundBy).toBe("architect");
    try {
      resolveVendorBaseUrl(undefined, record.vendorBaseUrl);
      throw new Error("expected ADAPTER_VENDOR_URL_MISSING");
    } catch (err) {
      expect(err).toMatchObject({ code: "ADAPTER_VENDOR_URL_MISSING", closed: true });
    }

    const kernelSrc = readFileSync(path.join(process.cwd(), "src/habitat/kernel.ts"), "utf8");
    expect(kernelSrc).toMatch(/ADAPTER_UNBOUND/);
    const pageSrc = readFileSync(path.join(process.cwd(), "src/http/architect-habitat-page.ts"), "utf8");
    expect(pageSrc).not.toMatch(/gpt-|claude-|api\.openai\.com|api\.anthropic\.com|OPENAI_API_KEY|AV_NO_VENDOR/);
    expect(pageSrc).toMatch(/Architect sits in the habitat/);
  });
});

describe("Architect habitat bind wizard", () => {
  it("is a stepped add path, not a catch-all form or admin dump", () => {
    const html = architectHabitatPageHtml();
    const pageSrc = readFileSync(path.join(process.cwd(), "src/http/architect-habitat-page.ts"), "utf8");
    expect(pageSrc).toMatch(/data-wizard-step/);
    for (const step of [
      "session",
      "attach-model",
      "attach-connector",
      "router",
      "aggregator",
      "confirm",
    ]) {
      expect(html).toMatch(new RegExp(`data-wizard-step="${step}"`));
      expect(html).toMatch(new RegExp(`data-step-marker="${step}"`));
    }
    expect(html).toMatch(/id="wizard"/);
    expect(html).toMatch(/data-path="add"/);
    expect(html).toMatch(/id="admin"/);
    expect(html).toMatch(/data-path="admin"/);
    expect(html).toMatch(/function wizardBindAdapter/);
    expect(html).toMatch(/function wizardBindConnector/);
    expect(html).toMatch(/function adminEditAdapter/);
    expect(html).toMatch(/function adminEditConnector/);
    expect(html).toMatch(/\/architect\/bind-adapter/);
    expect(html).toMatch(/\/architect\/edit-adapter-bind/);
    expect(html).toMatch(/\/architect\/bind-connector/);
    expect(html).toMatch(/\/architect\/edit-connector-bind/);
    expect(html).toMatch(/Codex Subscription/);
    expect(html).toMatch(/Grok Subscription/);
    expect(html).toMatch(/GLM subscription/);
    expect(html).toMatch(/Generic OpenAI \(vLLM \/ Ollama\)/);
    expect(html).toMatch(/>Claude</);
    expect(html).toMatch(/>Codex</);
    expect(html).toMatch(/>Grok</);
    expect(html).toMatch(/>Kimi</);
    expect(html).toMatch(/>GLM</);
    expect(html).not.toMatch(/localhost|:11434|:8000|127\.0\.0\.1:11434|127\.0\.0\.1:8000/);
    expect(html).not.toMatch(/sk-|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
    expect(html).toContain("Pyrallon habitat");
    expect(html).toContain("<footer>Pyrallon</footer>");
    expect(html).not.toMatch(/VEYRA|Architect Desktop|NemoClaw|AV Dev|Alpha Vector LLC/);
    const adminMarkup = html.slice(html.indexOf('id="admin"'), html.indexOf("<script>"));
    expect(adminMarkup).not.toMatch(/data-provider=/);
    expect(adminMarkup).not.toMatch(/data-mode="subscription"|data-mode="api"/);
    expect(adminMarkup).not.toMatch(/\/architect\/bind-adapter|\/architect\/bind-connector/);
    expect(html).toMatch(/async function adminEditAdapter\([\s\S]*\/architect\/edit-adapter-bind/);
    expect(html).toMatch(/async function adminEditConnector\([\s\S]*\/architect\/edit-connector-bind/);
    expect(html).toMatch(/async function wizardBindAdapter\([\s\S]*\/architect\/bind-adapter/);
    expect(html).toMatch(/async function wizardBindConnector\([\s\S]*\/architect\/bind-connector/);
    expect(html).toMatch(/async function wizardStartSubscription\([\s\S]*\/architect\/start-subscription-auth/);
    expect(html).toMatch(/async function wizardCompleteSubscription\([\s\S]*\/architect\/complete-subscription-auth/);
    expect(html).toMatch(/async function wizardStartConnector\([\s\S]*\/architect\/start-connector-auth/);
    expect(html).toMatch(/async function wizardCompleteConnector\([\s\S]*\/architect\/complete-connector-auth/);
    expect(html).toMatch(/id="subscription-guided-auth"/);
    expect(html).toMatch(/id="subscription-sign-in"/);
    expect(html).toMatch(/id="subscription-complete"/);
    expect(html).toMatch(/id="connector-guided-auth"/);
    expect(html).toMatch(/id="connector-sign-in"/);
    expect(html).toMatch(/id="connector-complete"/);
    expect(html).toMatch(/>GitHub</);
    expect(html).toMatch(/Generic \/ private MCP/);
    expect(html).toMatch(/>Sign in</);
    expect(html).not.toMatch(/id="subscription-start-url"/);
    expect(html).not.toMatch(/label for="subscription-start-url"/);
    expect(html).not.toMatch(/id="subscription-auth"/);
    expect(html).not.toMatch(/label for="subscription-auth"/);
    expect(html).not.toMatch(/subscription auth is required/);
    expect(html).not.toMatch(/type="password"[^>]*id="subscription-auth"|id="subscription-auth"[^>]*type="password"/);
    expect(html).not.toMatch(/async function adminEditAdapter\([\s\S]*\/architect\/bind-adapter/);
    expect(html).not.toMatch(/async function adminEditConnector\([\s\S]*\/architect\/bind-connector/);
    expect(adminMarkup).not.toMatch(
      /start-subscription-auth|complete-subscription-auth|subscription-sign-in|start-connector-auth|complete-connector-auth|connector-sign-in/,
    );
    expect(isAdminAddPath("admin", "add-model")).toBe(false);
    expect(isAdminAddPath("admin", "add-connector")).toBe(false);
    expect(isAdminAddPath("wizard", "add-model")).toBe(true);
    expect(isAdminAddPath("wizard", "add-connector")).toBe(true);
  });

  it("shows only the fields the chosen mode and provider need", () => {
    expect(HABITAT_PROVIDERS.map((row) => row.label)).toEqual(
      expect.arrayContaining([
        "Codex Subscription",
        "Grok Subscription",
        "GLM subscription",
        "Claude",
        "Codex",
        "Grok",
        "Kimi",
        "GLM",
        "Generic OpenAI (vLLM / Ollama)",
      ]),
    );
    const sub = visibleAttachFields("subscription", "sub-codex");
    expect(sub).toEqual({
      subscriptionAuth: "guided",
      startUrl: "hidden",
      apiKey: "hidden",
      vendorBaseUrl: "hidden",
      modelId: "hidden",
    });
    const api = visibleAttachFields("api", "api-claude");
    expect(api).toEqual({
      subscriptionAuth: "hidden",
      startUrl: "hidden",
      apiKey: "required",
      vendorBaseUrl: "optional",
      modelId: "required",
    });
    const generic = visibleAttachFields("api", "api-generic-openai");
    expect(generic).toEqual({
      subscriptionAuth: "hidden",
      startUrl: "hidden",
      apiKey: "optional",
      vendorBaseUrl: "required",
      modelId: "required",
    });
    expect(visibleAttachFields("api", "sub-codex").modelId).toBe("hidden");
    const genericChoice = HABITAT_PROVIDERS.find((row) => row.id === "api-generic-openai")!;
    expect(modelIdForBind(genericChoice, "local-llama")).toBe("local-llama");
    const subChoice = HABITAT_PROVIDERS.find((row) => row.id === "sub-codex")!;
    expect(modelIdForBind(subChoice, "")).toBe("codex-subscription");
  });

  it("wizard can bind more than one model and write Architect-entered router and aggregator", async () => {
    const live = await liveHttp("multi");
    const auth = { authorization: `Bearer ${live.architectToken}`, "content-type": "application/json" };
    const first = await fetch(`${live.url}/architect/bind-adapter`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ modelId: "claude-bind", vendorBaseUrl: "https://architect-typed.example/claude" }),
    });
    expect(first.status).toBe(201);
    const second = await fetch(`${live.url}/architect/bind-adapter`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ modelId: "generic-bind", vendorBaseUrl: "https://architect-typed.example/vllm" }),
    });
    expect(second.status).toBe(201);
    const creds = await fetch(`${live.url}/architect/set-adapter-credentials`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ apiKey: "av-generic-optional" }),
    });
    expect(creds.status).toBe(201);

    const routerRules = "fallback order: claude-bind then generic-bind; match coding tasks to generic-bind";
    const router = await fetch(`${live.url}/architect/set-adapter-router`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ rules: routerRules }),
    });
    expect(router.status).toBe(201);
    expect(((await router.json()) as { rules: string }).rules).toBe(routerRules);

    const combine = "gather then vote";
    const aggregator = await fetch(`${live.url}/architect/set-adapter-aggregator`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ combine }),
    });
    expect(aggregator.status).toBe(201);
    expect(((await aggregator.json()) as { combine: string }).combine).toBe(combine);

    const paths = computerRoot(live.computerBaseDir, live.tenantId);
    const store = loadAdapterBindStore(paths.adapterBindFile);
    expect(store.models.map((row) => row.modelId).sort()).toEqual(["claude-bind", "generic-bind"]);
    expect(store.models.every((row) => row.boundBy === "architect")).toBe(true);
    expect(store.models.find((row) => row.modelId === "generic-bind")?.vendorBaseUrl).toBe(
      "https://architect-typed.example/vllm",
    );
    const latest = loadAdapterBind(paths.adapterBindFile)!;
    expect(latest.modelId).toBe("generic-bind");
    expect(latest).not.toHaveProperty("apiKey");
    const writtenCreds = loadAdapterCredentials(paths.adapterCredentialsFile)!;
    expect(writtenCreds.writtenBy).toBe("architect");
    expect(writtenCreds.apiKey).toBe("av-generic-optional");

    const routerRecord = loadAdapterRouter(paths.adapterRouterFile)!;
    expect(routerRecord.boundBy).toBe("architect");
    expect(routerRecord.rules).toBe(routerRules);
    expect(routerRecord).not.toHaveProperty("apiKey");
    const aggregatorRecord = loadAdapterAggregator(paths.adapterAggregatorFile)!;
    expect(aggregatorRecord.boundBy).toBe("architect");
    expect(aggregatorRecord.combine).toBe(combine);
    expect(existsSync(path.join(paths.disk, "adapter-router.json"))).toBe(false);
    expect(existsSync(path.join(paths.disk, "adapter-aggregator.json"))).toBe(false);
    expect(statSync(paths.adapterRouterFile).mode & 0o777).toBe(0o600);
    expect(statSync(paths.adapterAggregatorFile).mode & 0o777).toBe(0o600);

    const listed = await fetch(`${live.url}/architect/adapter-bind`, { headers: auth });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { models: Array<{ modelId: string }> };
    expect(listedBody.models.map((row) => row.modelId).sort()).toEqual(["claude-bind", "generic-bind"]);
    expect(JSON.stringify(listedBody)).not.toMatch(/apiKey|av-generic-optional/);
  });

  it("admin cannot add a new model or connector; field cannot write router or aggregator", async () => {
    const live = await liveHttp("admin-gate");
    const auth = { authorization: `Bearer ${live.architectToken}`, "content-type": "application/json" };
    const fieldAuth = { authorization: `Bearer ${live.fieldToken}`, "content-type": "application/json" };

    const addViaAdmin = await fetch(`${live.url}/architect/edit-adapter-bind`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ modelId: "brand-new", vendorBaseUrl: "https://architect-typed.example" }),
    });
    expect(addViaAdmin.status).toBe(400);
    expect(((await addViaAdmin.json()) as { error: string }).error).toBe("ADAPTER_NOT_BOUND");
    expect(loadAdapterBind(computerRoot(live.computerBaseDir, live.tenantId).adapterBindFile)).toBeUndefined();

    const addConnectorViaAdmin = await fetch(`${live.url}/architect/edit-connector-bind`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ connectorId: "brand-new-world" }),
    });
    expect(addConnectorViaAdmin.status).toBe(400);
    expect(((await addConnectorViaAdmin.json()) as { error: string }).error).toBe("CONNECTOR_UNBOUND");

    const wizardAdd = await fetch(`${live.url}/architect/bind-adapter`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ modelId: "already-bound" }),
    });
    expect(wizardAdd.status).toBe(201);
    const adminEdit = await fetch(`${live.url}/architect/edit-adapter-bind`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ modelId: "already-bound", vendorBaseUrl: "https://architect-typed.example/edit" }),
    });
    expect(adminEdit.status).toBe(201);
    expect(loadAdapterBind(computerRoot(live.computerBaseDir, live.tenantId).adapterBindFile)?.vendorBaseUrl).toBe(
      "https://architect-typed.example/edit",
    );

    for (const route of [
      "/architect/set-adapter-router",
      "/architect/set-adapter-aggregator",
      "/architect/edit-adapter-bind",
      "/architect/edit-connector-bind",
      "/architect/start-subscription-auth",
      "/architect/complete-subscription-auth",
      "/architect/start-connector-auth",
      "/architect/complete-connector-auth",
    ]) {
      const denied = await fetch(`${live.url}${route}`, {
        method: "POST",
        headers: fieldAuth,
        body: JSON.stringify({ rules: "fallback", combine: "vote", modelId: "x", connectorId: "y" }),
      });
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    }
    for (const route of ["/architect/adapter-router", "/architect/adapter-aggregator", "/architect/adapter-bind"]) {
      const denied = await fetch(`${live.url}${route}`, { headers: fieldAuth });
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    }

    const missingRouter = await fetch(`${live.url}/architect/set-adapter-router`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rules: "fallback" }),
    });
    expect(missingRouter.status).toBe(401);
    expect(() =>
      architectWriteAdapterRouter({
        tenantId: live.tenantId,
        rules: "fallback",
        computerBaseDir: live.computerBaseDir,
        architectToken: live.fieldToken,
      }),
    ).toThrow(SurfaceViolationError);
    expect(() =>
      architectWriteAdapterAggregator({
        tenantId: live.tenantId,
        combine: "vote",
        computerBaseDir: live.computerBaseDir,
        architectToken: live.fieldToken,
      }),
    ).toThrow(SurfaceViolationError);
    expect(() =>
      architectEditAdapterBind({
        tenantId: live.tenantId,
        modelId: "already-bound",
        computerBaseDir: live.computerBaseDir,
        architectToken: live.fieldToken,
      }),
    ).toThrow(SurfaceViolationError);

    const inProcess = architectWriteAdapterRouter({
      tenantId: live.tenantId,
      rules: "capability match entered by Architect",
      computerBaseDir: live.computerBaseDir,
      architectToken: live.architectToken,
    });
    expect(inProcess.rules).toBe("capability match entered by Architect");
    expect(inProcess.boundBy).toBe("architect");

    const addSubscriptionViaAdmin = await fetch(`${live.url}/architect/edit-adapter-bind`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ modelId: "codex-subscription" }),
    });
    expect(addSubscriptionViaAdmin.status).toBe(400);
    expect(((await addSubscriptionViaAdmin.json()) as { error: string }).error).toBe("ADAPTER_NOT_BOUND");
  });
});

const SUBSCRIPTION_CHOICES = [
  { providerId: "sub-codex", modelId: "codex-subscription", label: "Codex Subscription" },
  { providerId: "sub-grok", modelId: "grok-subscription", label: "Grok Subscription" },
  { providerId: "sub-glm", modelId: "glm-subscription", label: "GLM subscription" },
] as const;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readVendorBody(init?: RequestInit): Promise<Record<string, string>> {
  const raw = typeof init?.body === "string" ? init.body : "";
  const contentType = String(
    init?.headers && typeof init.headers === "object" && "content-type" in init.headers
      ? (init.headers as Record<string, string>)["content-type"]
      : "",
  );
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function installOfficialVendorMocks() {
  const seen: string[] = [];
  const grok = new Map<string, { userCode: string; approved: boolean; token: string }>();
  const github = new Map<string, { userCode: string; approved: boolean; token: string }>();
  const glmCodes = new Map<string, { approved: boolean; token: string }>();
  const codex = new Map<string, { userCode: string; approved: boolean; token: string }>();
  let seq = 0;

  setVendorFetch(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push(`${method} ${url}`);
    const body = await readVendorBody(init);

    if (url === `${CODEX_ISSUER}${CODEX_USERCODE_PATH}`) {
      expect(body.client_id).toBe(CODEX_CLIENT_ID);
      expect(JSON.stringify(body)).not.toBe("{}");
      seq += 1;
      const userCode = `CODEX-${seq}`;
      const deviceAuthId = `codex_auth_${seq}`;
      codex.set(deviceAuthId, { userCode, approved: false, token: `codex_session_${seq}` });
      return jsonResponse(200, {
        device_auth_id: deviceAuthId,
        user_code: userCode,
        interval: "1",
      });
    }
    if (url === `${CODEX_ISSUER}${CODEX_TOKEN_POLL_PATH}`) {
      const row = codex.get(String(body.device_auth_id ?? ""));
      if (!row || row.userCode !== body.user_code) return jsonResponse(404, { error: "not_found" });
      if (!row.approved) return new Response("", { status: 403 });
      return jsonResponse(200, {
        authorization_code: `codex_code_${row.userCode}`,
        code_verifier: `codex_verifier_${row.userCode}`,
        code_challenge: `codex_challenge_${row.userCode}`,
      });
    }
    if (url === `${CODEX_ISSUER}${CODEX_OAUTH_TOKEN_PATH}`) {
      expect(body.grant_type).toBe("authorization_code");
      expect(body.client_id).toBe(CODEX_CLIENT_ID);
      expect(body.redirect_uri).toBe(CODEX_DEVICE_REDIRECT_URI);
      const row = [...codex.values()].find((item) => `codex_code_${item.userCode}` === body.code);
      if (!row) return jsonResponse(400, { error: "invalid_grant" });
      return jsonResponse(200, {
        access_token: row.token,
        refresh_token: `refresh_${row.token}`,
        id_token: `id_${row.token}`,
      });
    }

    if (url === `${GROK_ISSUER}${GROK_DEVICE_PATH}`) {
      expect(body.client_id).toBe(GROK_CLIENT_ID);
      expect(body.referrer).toBe("grok-build");
      expect(body.scope).toMatch(/grok-cli:access/);
      seq += 1;
      const deviceCode = `grok_device_${seq}`;
      const userCode = `GROK-${seq}`;
      grok.set(deviceCode, { userCode, approved: false, token: `grok_session_${seq}` });
      return jsonResponse(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: "https://auth.x.ai/device",
        expires_in: 900,
        interval: 1,
      });
    }
    if (url === `${GROK_ISSUER}${GROK_TOKEN_PATH}`) {
      expect(body.grant_type).toBe(GROK_DEVICE_GRANT);
      expect(body.client_id).toBe(GROK_CLIENT_ID);
      const row = grok.get(String(body.device_code ?? ""));
      if (!row) return jsonResponse(400, { error: "expired_token" });
      if (!row.approved) return jsonResponse(400, { error: "authorization_pending" });
      return jsonResponse(200, { access_token: row.token, token_type: "bearer" });
    }

    if (url === GLM_TOKEN_URL) {
      expect(body.provider).toBe("zai");
      expect(body.redirect_uri).toBe(GLM_REDIRECT_URI);
      const row = glmCodes.get(String(body.code ?? ""));
      if (!row || !row.approved) return jsonResponse(400, { error: "authorization_pending" });
      return jsonResponse(200, { access_token: row.token, zcodejwttoken: row.token });
    }
    if (url === GLM_DEAD_CLI_INIT || url.includes("/oauth/cli/init")) {
      throw new Error("dead api.z.ai/oauth/cli/init must not be the product path");
    }

    if (url === GITHUB_DEVICE_URL) {
      expect(body.client_id).toBe(GITHUB_CLIENT_ID);
      seq += 1;
      const deviceCode = `gh_device_${seq}`;
      const userCode = `GH-${seq}`;
      github.set(deviceCode, { userCode, approved: false, token: `gh_session_${seq}` });
      return jsonResponse(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      });
    }
    if (url === GITHUB_TOKEN_URL) {
      expect(body.grant_type).toBe(GITHUB_DEVICE_GRANT);
      expect(body.client_id).toBe(GITHUB_CLIENT_ID);
      const row = github.get(String(body.device_code ?? ""));
      if (!row) return jsonResponse(400, { error: "expired_token" });
      if (!row.approved) return jsonResponse(400, { error: "authorization_pending" });
      return jsonResponse(200, { access_token: row.token, token_type: "bearer" });
    }

    throw new Error(`unexpected vendor fetch ${method} ${url}`);
  });

  return {
    seen,
    approveCodex(userCode: string) {
      for (const row of codex.values()) {
        if (row.userCode === userCode) row.approved = true;
      }
    },
    approveGrok(userCode: string) {
      for (const row of grok.values()) {
        if (row.userCode === userCode) row.approved = true;
      }
    },
    approveGithub(userCode: string) {
      for (const row of github.values()) {
        if (row.userCode === userCode) row.approved = true;
      }
    },
    approveGlm(code: string, token: string) {
      glmCodes.set(code, { approved: true, token });
    },
  };
}

describe("Architect habitat official subscription attach", () => {
  it("choosing Codex / Grok / GLM starts that vendor official login and binds through existing writers", async () => {
    const live = await liveHttp("sub-attach");
    const mocks = installOfficialVendorMocks();
    const auth = { authorization: `Bearer ${live.architectToken}`, "content-type": "application/json" };

    for (const choice of SUBSCRIPTION_CHOICES) {
      const started = await fetch(`${live.url}/architect/start-subscription-auth`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ providerId: choice.providerId }),
      });
      expect(started.status).toBe(201);
      const pending = (await started.json()) as {
        authId: string;
        providerId: string;
        modelId: string;
        userCode?: string;
        verificationUri: string;
        status: string;
        access_token?: string;
        apiKey?: string;
        device_code?: string;
        startUrl?: string;
      };
      expect(pending.providerId).toBe(choice.providerId);
      expect(pending.modelId).toBe(choice.modelId);
      expect(pending.status).toBe("pending");
      expect(pending.access_token).toBeUndefined();
      expect(pending.apiKey).toBeUndefined();
      expect(pending.device_code).toBeUndefined();
      expect(pending.startUrl).toBeUndefined();
      expect(JSON.stringify(pending)).not.toMatch(/session_|device_/);

      if (choice.providerId === "sub-codex") {
        expect(pending.userCode).toMatch(/^CODEX-/);
        expect(pending.verificationUri).toBe(`${CODEX_ISSUER}${CODEX_VERIFICATION_PATH}`);
        expect(mocks.seen.some((row) => row.includes(`${CODEX_ISSUER}${CODEX_USERCODE_PATH}`))).toBe(true);
      }
      if (choice.providerId === "sub-grok") {
        expect(pending.userCode).toMatch(/^GROK-/);
        expect(pending.verificationUri).toBe("https://auth.x.ai/device");
        expect(mocks.seen.some((row) => row.includes(`${GROK_ISSUER}${GROK_DEVICE_PATH}`))).toBe(true);
      }
      if (choice.providerId === "sub-glm") {
        expect(pending.userCode).toBeUndefined();
        const authorize = new URL(pending.verificationUri);
        expect(`${authorize.origin}${authorize.pathname}`).toBe(GLM_AUTHORIZE_URL);
        expect(authorize.searchParams.get("client_id")).toBe(GLM_CLIENT_ID);
        expect(authorize.searchParams.get("redirect_uri")).toBe(GLM_REDIRECT_URI);
        expect(authorize.searchParams.get("response_type")).toBe("code");
      }

      const waiting = await fetch(`${live.url}/architect/complete-subscription-auth`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ authId: pending.authId }),
      });
      expect(waiting.status).toBe(200);
      expect(((await waiting.json()) as { status: string }).status).toBe("authorization_pending");
      expect(
        loadAdapterBind(computerRoot(live.computerBaseDir, live.tenantId).adapterBindFile)?.modelId,
      ).not.toBe(choice.modelId);

      let completeBody: Record<string, string> = { authId: pending.authId };
      if (choice.providerId === "sub-codex") mocks.approveCodex(pending.userCode ?? "");
      if (choice.providerId === "sub-grok") mocks.approveGrok(pending.userCode ?? "");
      if (choice.providerId === "sub-glm") {
        const state = new URL(pending.verificationUri).searchParams.get("state") ?? "";
        const code = `glm_code_${choice.modelId}`;
        mocks.approveGlm(code, `glm_session_${choice.modelId}`);
        completeBody = {
          authId: pending.authId,
          callbackUrl: `${GLM_REDIRECT_URI}?code=${code}&state=${state}`,
        };
      }
      const done = await fetch(`${live.url}/architect/complete-subscription-auth`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(completeBody),
      });
      expect(done.status).toBe(201);
      const bound = (await done.json()) as {
        status: string;
        modelId: string;
        boundBy: string;
        apiKey?: string;
        access_token?: string;
      };
      expect(bound.status).toBe("bound");
      expect(bound.modelId).toBe(choice.modelId);
      expect(bound.boundBy).toBe("architect");
      expect(bound.apiKey).toBeUndefined();
      expect(bound.access_token).toBeUndefined();
    }

    const paths = computerRoot(live.computerBaseDir, live.tenantId);
    const store = loadAdapterBindStore(paths.adapterBindFile);
    expect(store.models.map((row) => row.modelId).sort()).toEqual(
      ["codex-subscription", "glm-subscription", "grok-subscription"].sort(),
    );
    expect(store.models.every((row) => row.boundBy === "architect")).toBe(true);
    expect(store.models.every((row) => !("apiKey" in row))).toBe(true);
    const creds = loadAdapterCredentials(paths.adapterCredentialsFile)!;
    expect(creds.writtenBy).toBe("architect");
    expect(creds.apiKey.startsWith("glm_session_")).toBe(true);
    expect(statSync(paths.adapterBindFile).mode & 0o777).toBe(0o600);
    expect(statSync(paths.adapterCredentialsFile).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(paths.disk, "adapter-bind.json"))).toBe(false);
    expect(existsSync(path.join(paths.disk, "adapter-credentials.json"))).toBe(false);
    expect(mocks.seen.join("\n")).not.toMatch(/oauth\/cli\/init/);
  });

  it("password dump and Architect-typed POST {} issuer are gone; missing startUrl is not required", async () => {
    const html = architectHabitatPageHtml();
    expect(html).not.toMatch(/subscription auth is required/);
    expect(html).not.toMatch(/id="subscription-auth"/);
    expect(html).not.toMatch(/id="subscription-start-url"/);
    expect(html).toMatch(/wizardStartSubscription/);
    expect(html).toMatch(/Architect does not type an issuer URL/);
    expect(html).toMatch(/Subscription attach starts a guided sign-in; a token dump is not the product path/);

    const live = await liveHttp("sub-no-host");
    const mocks = installOfficialVendorMocks();
    const auth = { authorization: `Bearer ${live.architectToken}`, "content-type": "application/json" };
    const missing = await fetch(`${live.url}/architect/start-subscription-auth`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ providerId: "sub-codex" }),
    });
    expect(missing.status).toBe(201);
    const started = (await missing.json()) as { verificationUri: string; userCode: string };
    expect(started.verificationUri).toBe(`${CODEX_ISSUER}${CODEX_VERIFICATION_PATH}`);
    expect(started.userCode).toMatch(/^CODEX-/);
    expect(mocks.seen.some((row) => row === `POST ${CODEX_ISSUER}${CODEX_USERCODE_PATH}`)).toBe(true);

    const ignoredIssuer = await fetch(`${live.url}/architect/start-subscription-auth`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        providerId: "sub-grok",
        startUrl: "https://architect-typed.example/start",
      }),
    });
    expect(ignoredIssuer.status).toBe(201);
    expect(((await ignoredIssuer.json()) as { verificationUri: string }).verificationUri).toBe(
      "https://auth.x.ai/device",
    );
    expect(mocks.seen.join("\n")).not.toMatch(/architect-typed\.example/);

    const apiProvider = await fetch(`${live.url}/architect/start-subscription-auth`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ providerId: "api-generic-openai" }),
    });
    expect(apiProvider.status).toBe(400);
    expect(((await apiProvider.json()) as { error: string }).error).toBe("SUBSCRIPTION_PROVIDER_REQUIRED");

    const unauthenticated = await fetch(`${live.url}/architect/start-subscription-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "sub-codex" }),
    });
    expect(unauthenticated.status).toBe(401);

    const files = [
      "src/http/architect-habitat-page.ts",
      "src/http/architect-habitat-wizard.ts",
      "src/http/field-server.ts",
      "src/auth/architect-subscription-auth.ts",
      "src/habitat/subscription-auth.ts",
      "src/habitat/vendor-login.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(src).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|sk-/);
      expect(src).not.toMatch(/startUrl\s*=\s*["'`]https?:\/\/(localhost|127\.0\.0\.1|api\.)/);
      expect(src).not.toMatch(/JSON\.stringify\(\{\}\)/);
      expect(src).not.toMatch(/~\/\.codex\/auth\.json|~\/\.grok\/auth\.json|~\/\.zcode\//);
      expect(src).not.toMatch(/oauth\/cli\/init/);
    }
    const vendorSrc = readFileSync(path.join(process.cwd(), "src/habitat/vendor-login.ts"), "utf8");
    expect(vendorSrc).toMatch(/auth\.openai\.com/);
    expect(vendorSrc).toMatch(/auth\.x\.ai/);
    expect(vendorSrc).toMatch(/chat\.z\.ai/);
    expect(vendorSrc).toContain(CODEX_CLIENT_ID);
    expect(vendorSrc).toContain(GROK_CLIENT_ID);
    expect(vendorSrc).toContain(GLM_CLIENT_ID);
  });

  it("API and Generic OpenAI paths stay key/URL bind without localhost defaults", async () => {
    const live = await liveHttp("sub-api");
    const auth = { authorization: `Bearer ${live.architectToken}`, "content-type": "application/json" };
    const apiBind = await fetch(`${live.url}/architect/bind-adapter`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        modelId: "architect-typed-model",
        vendorBaseUrl: "https://architect-typed.example/vllm",
      }),
    });
    expect(apiBind.status).toBe(201);
    const apiKey = await fetch(`${live.url}/architect/set-adapter-credentials`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ apiKey: "av-api-still-works" }),
    });
    expect(apiKey.status).toBe(201);

    const paths = computerRoot(live.computerBaseDir, live.tenantId);
    const store = loadAdapterBindStore(paths.adapterBindFile);
    expect(store.models.map((row) => row.modelId)).toEqual(["architect-typed-model"]);
    expect(store.models[0]?.vendorBaseUrl).toBe("https://architect-typed.example/vllm");
    const creds = loadAdapterCredentials(paths.adapterCredentialsFile)!;
    expect(creds.writtenBy).toBe("architect");
    expect(creds.apiKey).toBe("av-api-still-works");

    const html = architectHabitatPageHtml();
    expect(html).not.toMatch(/localhost|:11434|:8000|127\.0\.0\.1:11434|127\.0\.0\.1:8000/);
    const generic = visibleAttachFields("api", "api-generic-openai");
    expect(generic.vendorBaseUrl).toBe("required");
    expect(generic.apiKey).toBe("optional");
  });
});

describe("Architect habitat official connector attach", () => {
  it("GitHub official OAuth writes connector-bind + credentials; generic MCP is Architect-typed URL", async () => {
    const live = await liveHttp("conn-attach");
    const mocks = installOfficialVendorMocks();
    const auth = { authorization: `Bearer ${live.architectToken}`, "content-type": "application/json" };

    expect(HABITAT_CONNECTORS.map((row) => row.label)).toEqual(["GitHub", "Generic / private MCP"]);

    const started = await fetch(`${live.url}/architect/start-connector-auth`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ connectorId: "github" }),
    });
    expect(started.status).toBe(201);
    const pending = (await started.json()) as {
      authId: string;
      connectorId: string;
      userCode: string;
      verificationUri: string;
      status: string;
      access_token?: string;
      secret?: string;
    };
    expect(pending.connectorId).toBe("github");
    expect(pending.status).toBe("pending");
    expect(pending.userCode).toMatch(/^GH-/);
    expect(pending.verificationUri).toBe("https://github.com/login/device");
    expect(pending.access_token).toBeUndefined();
    expect(pending.secret).toBeUndefined();
    expect(mocks.seen.some((row) => row === `POST ${GITHUB_DEVICE_URL}`)).toBe(true);

    const waiting = await fetch(`${live.url}/architect/complete-connector-auth`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ authId: pending.authId }),
    });
    expect(waiting.status).toBe(200);
    expect(((await waiting.json()) as { status: string }).status).toBe("authorization_pending");

    mocks.approveGithub(pending.userCode);
    const done = await fetch(`${live.url}/architect/complete-connector-auth`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ authId: pending.authId }),
    });
    expect(done.status).toBe(201);
    const bound = (await done.json()) as {
      status: string;
      connectorId: string;
      boundBy: string;
      secret?: string;
      access_token?: string;
    };
    expect(bound.status).toBe("bound");
    expect(bound.connectorId).toBe("github");
    expect(bound.boundBy).toBe("architect");
    expect(bound.secret).toBeUndefined();
    expect(bound.access_token).toBeUndefined();

    const generic = await fetch(`${live.url}/architect/bind-connector`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        connectorId: "private-mcp",
        baseUrl: "https://architect-typed.example/mcp",
        requiresCredentials: true,
      }),
    });
    expect(generic.status).toBe(201);
    await fetch(`${live.url}/architect/set-connector-credentials`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ connectorId: "private-mcp", secret: "av-mcp-secret" }),
    });

    const fieldAuth = { authorization: `Bearer ${live.fieldToken}`, "content-type": "application/json" };
    for (const route of ["/architect/start-connector-auth", "/architect/complete-connector-auth"]) {
      const denied = await fetch(`${live.url}${route}`, {
        method: "POST",
        headers: fieldAuth,
        body: JSON.stringify({ connectorId: "github", authId: pending.authId }),
      });
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    }

    const addViaAdmin = await fetch(`${live.url}/architect/edit-connector-bind`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ connectorId: "brand-new-oauth" }),
    });
    expect(addViaAdmin.status).toBe(400);
    expect(((await addViaAdmin.json()) as { error: string }).error).toBe("CONNECTOR_UNBOUND");

    const paths = computerRoot(live.computerBaseDir, live.tenantId);
    const store = loadConnectorBindStore(paths.connectorBindFile);
    expect(store.connectors.map((row) => row.connectorId).sort()).toEqual(["github", "private-mcp"]);
    expect(store.connectors.find((row) => row.connectorId === "private-mcp")?.baseUrl).toBe(
      "https://architect-typed.example/mcp",
    );
    expect(store.connectors.every((row) => row.boundBy === "architect")).toBe(true);
    expect(store.connectors.every((row) => !("secret" in row))).toBe(true);
    const creds = loadConnectorCredentialsStore(paths.connectorCredentialsFile);
    expect(creds.credentials.find((row) => row.connectorId === "github")?.secret.startsWith("gh_session_")).toBe(
      true,
    );
    expect(creds.credentials.find((row) => row.connectorId === "private-mcp")?.secret).toBe("av-mcp-secret");
    expect(statSync(paths.connectorBindFile).mode & 0o777).toBe(0o600);
    expect(statSync(paths.connectorCredentialsFile).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(paths.disk, "connector-bind.json"))).toBe(false);
    expect(existsSync(path.join(paths.disk, "connector-credentials.json"))).toBe(false);

    const html = architectHabitatPageHtml();
    expect(html).toContain("Pyrallon habitat");
    expect(html).not.toMatch(/VEYRA|Architect Desktop|NemoClaw|AV Dev|Alpha Vector LLC/);
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
  });
});
