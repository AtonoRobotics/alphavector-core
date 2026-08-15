import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { architectIssueFieldToken, architectRevokeFieldToken } from "../src/auth/architect-field-token.js";
import { FieldTokenBook } from "../src/auth/field-tokens.js";
import { computerRoot } from "../src/computer/paths.js";
import { AvError, SurfaceViolationError } from "../src/errors.js";
import { FieldClient } from "../src/http/field-client.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { startFieldServe } from "../src/http/field-listen.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { ALPHAVECTOR_RE_PIN_SHA, REPO_ROOT } from "./helpers.js";

const RE_PIN = "fc7e34e385743c7a6d0adcf9109bf5aa0c5a9230";
const servers: FieldHttpServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length) {
    await servers.pop()?.close();
  }
});

async function listenServe(tenantId: string, computerBaseDir: string) {
  const started = await startFieldServe({ tenantId, computerBaseDir, port: 0 });
  servers.push(started.server);
  return started;
}

function bootstrapArchitect(dir: string, tenantId: string) {
  return architectIssueFieldToken({
    tenantId,
    principal: "architect",
    computerBaseDir: dir,
  });
}

function issueFieldAsArchitect(dir: string, tenantId: string, architectToken: string) {
  return architectIssueFieldToken({
    tenantId,
    principal: "field",
    computerBaseDir: dir,
    architectToken,
  });
}

describe("tenant-issued field tokens on computer disk", () => {
  it("keeps the RE fixture pin at fc7e34e", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
  });

  it("stores a hashed token beside secrets and cards, not inside disk/", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-ftok-"));
    const book = new FieldTokenBook(dir);
    const issued = book.issue({ tenantId: "t1", principal: "field", actor: "architect" });
    const paths = computerRoot(dir, "t1");
    expect(paths.fieldTokensFile).toBe(path.join(dir, "tenants", "t1", "field-tokens.json"));
    expect(existsSync(paths.fieldTokensFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "field-tokens.json"))).toBe(false);
    const raw = readFileSync(paths.fieldTokensFile, "utf8");
    expect(raw).not.toContain(issued.token);
    expect(raw).toMatch(/"principal": "field"/);
    expect(raw).toMatch(/"status": "active"/);

    const reloaded = new FieldTokenBook(dir);
    expect(reloaded.lookup(issued.token, "t1")).toBe("field");
    expect(reloaded.lookup("field-dev-token", "t1")).toBeUndefined();
    expect(reloaded.lookup(`field-t1`, "t1")).toBeUndefined();
  });

  it("refuses field users issuing tokens and missing store invents no session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-ftok-miss-"));
    const book = new FieldTokenBook(dir);
    expect(() => book.issue({ tenantId: "t1", principal: "field", actor: "field" })).toThrow(
      SurfaceViolationError,
    );
    expect(book.lookup("field-dev-token", "t1")).toBeUndefined();
    expect(existsSync(computerRoot(dir, "t1").fieldTokensFile)).toBe(false);

    const { core, pack } = await bootFieldCore("missing", { computerBaseDir: dir });
    const server = new FieldHttpServer({ core, pack, tenantId: "missing" });
    servers.push(server);
    const { url } = await server.listen(0, "127.0.0.1");
    const res = await fetch(`${url}/field/home`, {
      headers: { authorization: "Bearer field-dev-token" },
    });
    expect(res.status).toBe(401);
    expect(existsSync(computerRoot(dir, "missing").fieldTokensFile)).toBe(false);
  });

  it("corrupt store refuses to invent a token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-ftok-bad-"));
    const paths = computerRoot(dir, "t1");
    await mkdir(path.dirname(paths.fieldTokensFile), { recursive: true });
    await writeFile(paths.fieldTokensFile, "{not-json", "utf8");
    const book = new FieldTokenBook(dir);
    expect(() => book.lookup("anything", "t1")).toThrow(AvError);
    expect(() => book.lookup("anything", "t1")).toThrow(/corrupt/i);

    const guessed = await mkdtemp(path.join(os.tmpdir(), "av-ftok-guess-"));
    const guessPath = computerRoot(guessed, "corrupt");
    await mkdir(path.dirname(guessPath.fieldTokensFile), { recursive: true });
    await writeFile(
      guessPath.fieldTokensFile,
      JSON.stringify({ tokens: [{ principal: "field", status: "active" }] }),
      "utf8",
    );
    const guessedBook = new FieldTokenBook(guessed);
    expect(() => guessedBook.lookup("field-dev-token", "corrupt")).toThrow(/corrupt/i);

    const { core, pack } = await bootFieldCore("corrupt", { computerBaseDir: guessed });
    const server = new FieldHttpServer({ core, pack, tenantId: "corrupt" });
    servers.push(server);
    const { url } = await server.listen(0, "127.0.0.1");
    const res = await fetch(`${url}/field/home`, {
      headers: { authorization: "Bearer field-dev-token" },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("TOKEN_STORE_CORRUPT");
  });

  it("accepts the same issued token for field start and card approve after restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-ftok-http-"));
    const architect = bootstrapArchitect(dir, "restart");
    const issued = issueFieldAsArchitect(dir, "restart", architect.token);
    const first = await listenServe("restart", dir);
    const field = new FieldClient(first.url, issued.token);
    const journey = await field.start("buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");
    let cardId = "";
    try {
      await field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "buyer",
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      expect(err).toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
      cardId = (err as { cardId: string }).cardId;
    }
    await first.server.close();

    const second = await listenServe("restart", dir);
    const again = new FieldClient(second.url, issued.token);
    await expect(
      new FieldClient(second.url, "field-dev-token").start("buyer", "demo must not work"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      new FieldClient(second.url, "field-restart").start("buyer", "pattern must not work"),
    ).rejects.toMatchObject({ status: 401 });

    const home = await again.home();
    expect(home.inbox.map((c) => c.cardId)).toEqual([cardId]);
    const approved = await again.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.effect?.executed).toBe(true);
  });

  it("field-serve does not mint a token and does not bake a secret into HTML", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-ftok-serve-"));
    const issue = vi.spyOn(FieldTokenBook.prototype, "issue");
    const started = await listenServe("fresh", dir);
    expect(issue).not.toHaveBeenCalled();
    expect(existsSync(computerRoot(dir, "fresh").fieldTokensFile)).toBe(false);

    const page = await fetch(started.url);
    const html = await page.text();
    expect(html).not.toMatch(/window\.FIELD_DEFAULTS/);
    expect(html).toMatch(/Issued field token/);
    expect(html).toMatch(/Paste a token Architect issued/);
    expect(html).not.toMatch(/"token":\s*"[A-Za-z0-9_-]{20,}"/);

    const denied = await fetch(`${started.url}/field/home`);
    expect(denied.status).toBe(401);
    expect(issue).not.toHaveBeenCalled();
    expect(existsSync(computerRoot(dir, "fresh").fieldTokensFile)).toBe(false);
    issue.mockRestore();
  });

  it("leaves an existing token book unchanged when serve starts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-ftok-unchanged-"));
    const architect = bootstrapArchitect(dir, "kept");
    const issued = issueFieldAsArchitect(dir, "kept", architect.token);
    const file = computerRoot(dir, "kept").fieldTokensFile;
    const before = readFileSync(file, "utf8");
    const issue = vi.spyOn(FieldTokenBook.prototype, "issue");
    const started = await listenServe("kept", dir);
    expect(issue).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe(before);
    const html = await (await fetch(started.url)).text();
    expect(html).not.toContain(issued.token);
    issue.mockRestore();
  });

  it("accepts a token Architect issued and returns 401 after Architect revokes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-ftok-arch-"));
    const architect = bootstrapArchitect(dir, "issued");
    const issued = issueFieldAsArchitect(dir, "issued", architect.token);
    expect(issued.principal).toBe("field");
    expect(issued.tenantId).toBe("issued");

    const first = await listenServe("issued", dir);
    const field = new FieldClient(first.url, issued.token);
    const journey = await field.start("buyer", "Architect issued this token");
    expect(journey.status).toBe("open");
    await first.server.close();

    architectRevokeFieldToken({
      tenantId: "issued",
      tokenId: issued.tokenId,
      computerBaseDir: dir,
      architectToken: architect.token,
    });
    const second = await listenServe("issued", dir);
    await expect(
      new FieldClient(second.url, issued.token).start("buyer", "Revoked must not start"),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  it("keeps architect issue and field-serve listen off the field home screen", async () => {
    const cli = await readFile(path.join(REPO_ROOT, "src/cli.ts"), "utf8");
    expect(cli).not.toMatch(/fieldTokens\.issue/);
    expect(cli).not.toMatch(/pageToken/);
    expect(cli).toMatch(/architectIssueFieldToken/);
    expect(cli).toMatch(/architectRevokeFieldToken/);
    expect(cli).toMatch(/--architect-token/);
    expect(cli).toMatch(/AV_ARCHITECT_TOKEN/);
    expect(cli).toMatch(/startFieldServe/);
    expect(cli).toMatch(/field-client requires --token or AV_FIELD_TOKEN/);

    const listen = await readFile(path.join(REPO_ROOT, "src/http/field-listen.ts"), "utf8");
    expect(listen).not.toMatch(/fieldTokens\.issue|\.issue\(/);
    expect(listen).not.toMatch(/pageToken/);

    const ios = await readFile(path.join(REPO_ROOT, "clients/field-ios/Field/FieldAPI.swift"), "utf8");
    expect(ios).not.toMatch(/OAuth|SSO|MLS/);
  });
});

describe("Architect credential required to issue and revoke", () => {
  it("binary alone cannot issue or revoke", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-arch-binary-"));
    expect(() =>
      architectIssueFieldToken({ tenantId: "t1", principal: "field", computerBaseDir: dir }),
    ).toThrow(SurfaceViolationError);
    expect(() =>
      architectIssueFieldToken({ tenantId: "t1", principal: "field", computerBaseDir: dir }),
    ).toThrow(/Shell is not Architect/);
    expect(() =>
      architectRevokeFieldToken({ tenantId: "t1", tokenId: "ftok_none", computerBaseDir: dir }),
    ).toThrow(/Shell is not Architect/);
    expect(existsSync(computerRoot(dir, "t1").fieldTokensFile)).toBe(false);
  });

  it("a field token cannot issue or revoke", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-arch-field-"));
    const architect = bootstrapArchitect(dir, "t1");
    const field = issueFieldAsArchitect(dir, "t1", architect.token);
    expect(() =>
      architectIssueFieldToken({
        tenantId: "t1",
        principal: "field",
        computerBaseDir: dir,
        architectToken: field.token,
      }),
    ).toThrow(/field token cannot issue or revoke/);
    expect(() =>
      architectRevokeFieldToken({
        tenantId: "t1",
        tokenId: field.tokenId,
        computerBaseDir: dir,
        architectToken: field.token,
      }),
    ).toThrow(/field token cannot issue or revoke/);
    const book = new FieldTokenBook(dir);
    expect(book.lookup(field.token, "t1")).toBe("field");
  });

  it("an Architect credential can issue and revoke", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-arch-can-"));
    const architect = bootstrapArchitect(dir, "t1");
    expect(architect.principal).toBe("architect");
    const paths = computerRoot(dir, "t1");
    const raw = readFileSync(paths.fieldTokensFile, "utf8");
    expect(raw).not.toContain(architect.token);
    expect(existsSync(path.join(paths.disk, "field-tokens.json"))).toBe(false);

    const field = issueFieldAsArchitect(dir, "t1", architect.token);
    const book = new FieldTokenBook(dir);
    expect(book.lookup(architect.token, "t1")).toBe("architect");
    expect(book.lookup(field.token, "t1")).toBe("field");

    architectRevokeFieldToken({
      tenantId: "t1",
      tokenId: field.tokenId,
      computerBaseDir: dir,
      architectToken: architect.token,
    });
    expect(new FieldTokenBook(dir).lookup(field.token, "t1")).toBeUndefined();
  });

  it("bootstraps the first Architect credential once", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-arch-once-"));
    const first = bootstrapArchitect(dir, "t1");
    expect(first.principal).toBe("architect");
    expect(new FieldTokenBook(dir).hasActiveArchitect("t1")).toBe(true);

    expect(() => bootstrapArchitect(dir, "t1")).toThrow(SurfaceViolationError);
    expect(() => bootstrapArchitect(dir, "t1")).toThrow(/Shell is not Architect/);

    const second = architectIssueFieldToken({
      tenantId: "t1",
      principal: "architect",
      computerBaseDir: dir,
      architectToken: first.token,
    });
    expect(second.principal).toBe("architect");
    expect(second.token).not.toBe(first.token);
  });

  it("missing, unknown, or revoked Architect credential fails closed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-arch-closed-"));
    expect(() =>
      architectIssueFieldToken({
        tenantId: "t1",
        principal: "architect",
        computerBaseDir: dir,
        architectToken: "not-issued",
      }),
    ).toThrow(AvError);
    expect(() =>
      architectIssueFieldToken({
        tenantId: "t1",
        principal: "architect",
        computerBaseDir: dir,
        architectToken: "not-issued",
      }),
    ).toThrow(/Unknown or revoked Architect credential/);

    const first = bootstrapArchitect(dir, "t1");
    architectRevokeFieldToken({
      tenantId: "t1",
      tokenId: first.tokenId,
      computerBaseDir: dir,
      architectToken: first.token,
    });
    expect(() =>
      architectIssueFieldToken({
        tenantId: "t1",
        principal: "field",
        computerBaseDir: dir,
        architectToken: first.token,
      }),
    ).toThrow(/Unknown or revoked Architect credential/);
    expect(new FieldTokenBook(dir).hasActiveArchitect("t1")).toBe(false);

    const recovered = bootstrapArchitect(dir, "t1");
    expect(recovered.principal).toBe("architect");
    expect(recovered.token).not.toBe(first.token);
  });
});
