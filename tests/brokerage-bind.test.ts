import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { architectWriteBrokerage } from "../src/auth/architect-brokerage.js";
import { architectIssueFieldToken } from "../src/auth/architect-field-token.js";
import { computerRoot } from "../src/computer/paths.js";
import { AvError, SurfaceViolationError } from "../src/errors.js";
import {
  resolveBrokerageBind,
  unsignedBrokeragePayload,
} from "../src/habitat/brokerage-bind.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import { FieldClient } from "../src/http/field-client.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { REQUIRED_PACK_SECTIONS } from "../src/packs/types.js";
import { signPayload } from "../src/packs/signing.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  bootTestFieldCore,
  makeAnchors,
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

const GENERIC_RULES = {
  consentRequired: true,
  channels: ["sms", "email"],
};

function bootstrapArchitect(dir: string, tenantId = "t1") {
  return architectIssueFieldToken({
    tenantId,
    principal: "architect",
    computerBaseDir: dir,
  });
}

function issueField(dir: string, tenantId: string, architectToken: string) {
  return architectIssueFieldToken({
    tenantId,
    principal: "field",
    computerBaseDir: dir,
    architectToken,
  });
}

/** Field HTTP only. No tenant computer — CONFIG_PATH 403 does not need a machine. */
async function liveFieldHttp(tenantId = "t1") {
  const { core, pack } = await bootTestFieldCore(tenantId, { adapter: new DryStemAdapter() });
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
    core,
    pack,
    url,
    field: new FieldClient(url, field.token),
    fieldToken: field.token,
  };
}

function counselSign(tenantId: string, rules: unknown, counselPrivate: string): string {
  return signPayload(unsignedBrokeragePayload(tenantId, rules), counselPrivate);
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

describe("tenant brokerage bind", () => {
  it("keeps the RE fixture pin at 5091328 and does not add VEYRA, Desk, Shape, or Director", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const note = readFileSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/SOURCE.md"), "utf8");
    expect(note).toContain(RE_PIN);
    const bindSrc = readFileSync(path.join(REPO_ROOT, "src/habitat/brokerage-bind.ts"), "utf8");
    const writeSrc = readFileSync(path.join(REPO_ROOT, "src/auth/architect-brokerage.ts"), "utf8");
    for (const src of [bindSrc, writeSrc]) {
      expect(src).not.toMatch(/VEYRA/);
      expect(src).not.toMatch(/\bDesk\b|\bShape\b|\bDirector\b|\bPlay\b|\bPlant\b|\bHIL\b|\bThor\b/);
      expect(src).not.toMatch(/Mission Control/);
      expect(src).not.toMatch(/\bT0\b|\bT1\b|\bT2\b|\bT3\b/);
    }
  });

  it("pack schema / REQUIRED_PACK_SECTIONS does not gain a brokerage section", () => {
    expect(REQUIRED_PACK_SECTIONS).not.toContain("brokerage");
    expect([...REQUIRED_PACK_SECTIONS]).toEqual([
      "identity",
      "roles",
      "journeyKinds",
      "actionClassVerbs",
      "policy",
      "connectors",
      "recordPartyKnowledge",
      "evidenceEvalFixtures",
      "askCeilings",
      "fieldLanguageMap",
    ]);
    const typesSrc = readFileSync(path.join(REPO_ROOT, "src/packs/types.ts"), "utf8");
    const schemaSrc = readFileSync(path.join(REPO_ROOT, "src/packs/schema.ts"), "utf8");
    expect(typesSrc).not.toMatch(/brokerage/i);
    expect(schemaSrc).not.toMatch(/brokerage/i);
    expect(typesSrc).toMatch(/adapter\?: PackAdapterDeclaration/);
    expect(typesSrc).toMatch(/routines\?: PackRoutineDeclaration/);
  });

  it("missing bind is BROKERAGE_UNBOUND; a fixture is not a bind", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-brokerage-miss-"));
    const keys = makeAnchors();
    const paths = computerRoot(dir, "t1");
    expect(paths.brokerageFile).toBe(path.join(dir, "tenants", "t1", "brokerage.json"));
    expect(existsSync(paths.brokerageFile)).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/pack.json"))).toBe(true);

    expect(() => resolveBrokerageBind(dir, "t1", keys.anchors)).toThrow(AvError);
    try {
      resolveBrokerageBind(dir, "t1", keys.anchors);
      expect.fail("missing bind must fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(AvError);
      expect(err).toMatchObject({
        code: "BROKERAGE_UNBOUND",
        closed: true,
        message: expect.stringMatching(/missing|Architect must bind/i),
      });
    }

    try {
      resolveBrokerageBind(undefined, "t1", keys.anchors);
      expect.fail("unbound computer must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: "BROKERAGE_UNBOUND", closed: true });
    }
    expect(existsSync(paths.brokerageFile)).toBe(false);
  });

  it("Architect writes a counsel-signed bind onto tenant disk; resolve hydrates that bind", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-brokerage-write-"));
    const { token: architectToken } = bootstrapArchitect(dir);
    const keys = makeAnchors();
    const counselSignature = counselSign("t1", GENERIC_RULES, keys.counselPrivate);

    const written = architectWriteBrokerage({
      tenantId: "t1",
      rules: GENERIC_RULES,
      counselSignature,
      computerBaseDir: dir,
      architectToken,
      anchors: keys.anchors,
    });
    expect(written).toMatchObject({
      tenantId: "t1",
      rules: GENERIC_RULES,
      boundBy: "architect",
    });
    expect(written.signatures.counselEval).toBe(counselSignature);

    const paths = computerRoot(dir, "t1");
    expect(paths.brokerageFile).toBe(path.join(dir, "tenants", "t1", "brokerage.json"));
    expect(existsSync(paths.brokerageFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "brokerage.json"))).toBe(false);
    expect(statSync(paths.brokerageFile).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(paths.brokerageFile, "utf8")) as {
      tenantId: string;
      boundBy: string;
      rules: unknown;
    };
    expect(raw).toMatchObject({
      tenantId: "t1",
      boundBy: "architect",
      rules: GENERIC_RULES,
    });
    expect(JSON.stringify(raw)).not.toMatch(/apiKey|password|listing|buyer|seller/i);

    const hydrated = resolveBrokerageBind(dir, "t1", keys.anchors);
    expect(hydrated).toMatchObject({
      tenantId: "t1",
      rules: GENERIC_RULES,
      boundBy: "architect",
      signatures: { counselEval: counselSignature },
    });
    expect(hydrated.boundAt).toBe(written.boundAt);
  });

  it("Architect CLI bind-brokerage writes tenants/{id}/brokerage.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-brokerage-cli-"));
    const { token: architectToken } = bootstrapArchitect(dir);
    const env = await withProductTrustEnv();
    restoreProductEnv.push(env.restore);
    const keys = makeAnchors();
    process.env.AV_ARCHITECT_PUBLIC_KEY = keys.anchors.architectPublicKeyPem;
    process.env.AV_COUNSEL_EVAL_PUBLIC_KEY = keys.anchors.counselEvalPublicKeyPem;
    const counselSignature = counselSign("t1", GENERIC_RULES, keys.counselPrivate);
    const rulesFile = path.join(dir, "rules.json");
    await writeFile(rulesFile, `${JSON.stringify(GENERIC_RULES)}\n`, "utf8");

    const out = runArchitectCli(
      [
        "architect",
        "bind-brokerage",
        "--tenant",
        "t1",
        "--rules-file",
        rulesFile,
        "--counsel-signature",
        counselSignature,
        "--architect-token",
        architectToken,
      ],
      { computerBaseDir: dir, architectToken },
    );
    expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(0);
    expect(out.stdout).toMatch(/"boundBy": "architect"/);
    expect(existsSync(computerRoot(dir, "t1").brokerageFile)).toBe(true);
    expect(resolveBrokerageBind(dir, "t1", keys.anchors).rules).toEqual(GENERIC_RULES);
  });

  it("unsigned, incomplete, and tampered binds fail closed as BROKERAGE_UNBOUND", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-brokerage-fail-"));
    const { token: architectToken } = bootstrapArchitect(dir);
    const keys = makeAnchors();
    const other = makeAnchors();
    const file = computerRoot(dir, "t1").brokerageFile;

    try {
      architectWriteBrokerage({
        tenantId: "t1",
        rules: GENERIC_RULES,
        counselSignature: "",
        computerBaseDir: dir,
        architectToken,
        anchors: keys.anchors,
      });
      expect.fail("unsigned write must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: "BROKERAGE_UNBOUND", closed: true });
    }
    expect(existsSync(file)).toBe(false);

    expect(() =>
      architectWriteBrokerage({
        tenantId: "t1",
        rules: {},
        counselSignature: "not-a-signature",
        computerBaseDir: dir,
        architectToken,
        anchors: keys.anchors,
      }),
    ).toThrow(AvError);
    try {
      architectWriteBrokerage({
        tenantId: "t1",
        rules: {},
        counselSignature: "not-a-signature",
        computerBaseDir: dir,
        architectToken,
        anchors: keys.anchors,
      });
      expect.fail("empty rules must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: "BROKERAGE_UNBOUND", closed: true });
    }

    const wrongSig = counselSign("t1", GENERIC_RULES, other.counselPrivate);
    try {
      architectWriteBrokerage({
        tenantId: "t1",
        rules: GENERIC_RULES,
        counselSignature: wrongSig,
        computerBaseDir: dir,
        architectToken,
        anchors: keys.anchors,
      });
      expect.fail("foreign counsel signature must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: "BROKERAGE_UNBOUND", closed: true });
    }
    expect(existsSync(file)).toBe(false);

    const good = counselSign("t1", GENERIC_RULES, keys.counselPrivate);
    architectWriteBrokerage({
      tenantId: "t1",
      rules: GENERIC_RULES,
      counselSignature: good,
      computerBaseDir: dir,
      architectToken,
      anchors: keys.anchors,
    });
    const before = readFileSync(file, "utf8");
    const parsed = JSON.parse(before) as { rules: { consentRequired: boolean; channels: string[] } };
    parsed.rules.consentRequired = false;
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    try {
      resolveBrokerageBind(dir, "t1", keys.anchors);
      expect.fail("tampered bind must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: "BROKERAGE_UNBOUND", closed: true });
    }

    writeFileSync(file, "{not-json", "utf8");
    try {
      resolveBrokerageBind(dir, "t1", keys.anchors);
      expect.fail("corrupt bind must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: "BROKERAGE_UNBOUND", closed: true });
    }

    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ tenantId: "t1", rules: GENERIC_RULES, boundBy: "architect", boundAt: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );
    try {
      resolveBrokerageBind(dir, "t1", keys.anchors);
      expect.fail("unsigned on-disk bind must fail closed");
    } catch (err) {
      expect(err).toMatchObject({ code: "BROKERAGE_UNBOUND", closed: true });
    }
  });

  it("field cannot configure, author, or override brokerage (SURFACE_VIOLATION / 403)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-brokerage-field-"));
    const { token: architectToken } = bootstrapArchitect(dir);
    const { token: fieldToken } = issueField(dir, "t1", architectToken);
    const { field, fieldToken: httpFieldToken, url } = await liveFieldHttp("t1");
    const keys = makeAnchors();
    const counselSignature = counselSign("t1", GENERIC_RULES, keys.counselPrivate);

    expect(() =>
      architectWriteBrokerage({
        tenantId: "t1",
        rules: GENERIC_RULES,
        counselSignature,
        computerBaseDir: dir,
        architectToken: fieldToken,
        anchors: keys.anchors,
      }),
    ).toThrow(SurfaceViolationError);
    expect(() =>
      architectWriteBrokerage({
        tenantId: "t1",
        rules: GENERIC_RULES,
        counselSignature,
        computerBaseDir: dir,
        architectToken: fieldToken,
        anchors: keys.anchors,
      }),
    ).toThrow(/field token|cannot bind|brokerage/i);
    expect(existsSync(computerRoot(dir, "t1").brokerageFile)).toBe(false);

    const rulesFile = path.join(dir, "rules.json");
    writeFileSync(rulesFile, `${JSON.stringify(GENERIC_RULES)}\n`, "utf8");
    const env = await withProductTrustEnv();
    restoreProductEnv.push(env.restore);
    process.env.AV_ARCHITECT_PUBLIC_KEY = keys.anchors.architectPublicKeyPem;
    process.env.AV_COUNSEL_EVAL_PUBLIC_KEY = keys.anchors.counselEvalPublicKeyPem;

    const shell = runArchitectCli(
      [
        "architect",
        "bind-brokerage",
        "--tenant",
        "t1",
        "--rules-file",
        rulesFile,
        "--counsel-signature",
        counselSignature,
      ],
      { computerBaseDir: dir },
    );
    expect(shell.status).not.toBe(0);
    expect(`${shell.stdout}\n${shell.stderr}`).toMatch(/Shell is not Architect/);

    const fieldCli = runArchitectCli(
      [
        "architect",
        "bind-brokerage",
        "--tenant",
        "t1",
        "--rules-file",
        rulesFile,
        "--counsel-signature",
        counselSignature,
        "--architect-token",
        fieldToken,
      ],
      { computerBaseDir: dir, architectToken: fieldToken },
    );
    expect(fieldCli.status).not.toBe(0);
    expect(`${fieldCli.stdout}\n${fieldCli.stderr}`).toMatch(/field token|cannot bind|brokerage/i);
    expect(existsSync(computerRoot(dir, "t1").brokerageFile)).toBe(false);

    const home = await field.home();
    expect(JSON.stringify(home)).not.toMatch(/brokerage|counselEval|bind-brokerage/i);
    expect(home.architectControls).toEqual([]);

    const blocked = await fetch(`${url}/field/brokerage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${httpFieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ rules: GENERIC_RULES, counselSignature }),
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: string }).error).toBe("SURFACE_VIOLATION");
    expect(existsSync(computerRoot(dir, "t1").brokerageFile)).toBe(false);

    architectWriteBrokerage({
      tenantId: "t1",
      rules: GENERIC_RULES,
      counselSignature,
      computerBaseDir: dir,
      architectToken,
      anchors: keys.anchors,
    });
    const override = await fetch(`${url}/field/brokerage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${httpFieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ rules: { consentRequired: false } }),
    });
    expect(override.status).toBe(403);
    expect(resolveBrokerageBind(dir, "t1", keys.anchors).rules).toEqual(GENERIC_RULES);

    const fieldSrc = readFileSync(path.join(REPO_ROOT, "src/http/field-server.ts"), "utf8");
    expect(fieldSrc).toMatch(/brokerage/);
    expect(fieldSrc).not.toMatch(/app\.post\(["']\/field\/brokerage/);
    const ios = readFileSync(path.join(REPO_ROOT, "clients/field-ios/Field/FieldAPI.swift"), "utf8");
    expect(ios).not.toMatch(/brokerage/i);
  });
});
