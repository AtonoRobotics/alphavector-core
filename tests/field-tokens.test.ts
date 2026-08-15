import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FieldTokenBook } from "../src/auth/field-tokens.js";
import { computerRoot } from "../src/computer/paths.js";
import { AvError, SurfaceViolationError } from "../src/errors.js";
import { FieldClient } from "../src/http/field-client.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { ALPHAVECTOR_RE_PIN_SHA } from "./helpers.js";

const RE_PIN = "fc7e34e385743c7a6d0adcf9109bf5aa0c5a9230";
const servers: FieldHttpServer[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.close();
  }
});

async function liveIssued(tenantId: string, computerBaseDir: string, fieldToken?: string) {
  const { core, pack } = await bootFieldCore(tenantId, { computerBaseDir });
  const token =
    fieldToken ?? core.fieldTokens.issue({ tenantId, principal: "field", actor: "architect" }).token;
  const server = new FieldHttpServer({ core, pack, tenantId, pageToken: token });
  servers.push(server);
  const { url } = await server.listen(0, "127.0.0.1");
  return { server, url, token, core, field: new FieldClient(url, token) };
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
    const first = await liveIssued("restart", dir);
    const journey = await first.field.start("buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");
    let cardId = "";
    try {
      await first.field.progress(journey.id, {
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

    const second = await liveIssued("restart", dir, first.token);
    await expect(
      new FieldClient(second.url, "field-dev-token").start("buyer", "demo must not work"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      new FieldClient(second.url, "field-restart").start("buyer", "pattern must not work"),
    ).rejects.toMatchObject({ status: 401 });

    const home = await second.field.home();
    expect(home.inbox.map((c) => c.cardId)).toEqual([cardId]);
    const approved = await second.field.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.effect?.executed).toBe(true);
  });
});
