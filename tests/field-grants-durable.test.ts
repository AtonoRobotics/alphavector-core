import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computerRoot } from "../src/computer/paths.js";
import { AvError, SurfaceViolationError } from "../src/errors.js";
import { GrantBook } from "../src/grants/store.js";
import { habitatAskReason } from "../src/grants/ask.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import { reapHeldCoders } from "../src/habitat/index.js";
import { FieldClient } from "../src/http/field-client.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { AlphaVectorCore } from "../src/kernel.js";
import { ALPHAVECTOR_RE_PIN_SHA, bootTestFieldCore, createOpenStart, signedGenericPack } from "./helpers.js";
import {
  bindWorldForPack,
  closeWorldHttp,
  recordedSendOf,
  useWorldHttp,
  WORLD_FIXTURE_SEND,
} from "./world-double.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const servers: FieldHttpServer[] = [];

afterEach(async () => {
  reapHeldCoders();
  await closeWorldHttp();
  while (servers.length) {
    await servers.pop()?.close();
  }
});

function authorize(book: GrantBook, tenantId: string, agentId: string) {
  return book.write({
    actor: "architect",
    tenantId,
    agentId,
    actionClass: "communicate",
    state: "authorized",
    bounds: { channels: ["email"] },
    owner: "architect-1",
    evidenceIds: ["ev1"],
    evalIds: ["eval1"],
    fieldNotice: "Follow-up emails will now send without asking. You can kill this.",
  });
}

async function liveDurable(
  tenantId: string,
  computerBaseDir: string,
  issued?: { field: string },
) {
  const { core, pack } = await bootTestFieldCore(tenantId, {
    computerBaseDir,
    adapter: new DryStemAdapter(),
  });
  let fieldToken = issued?.field;
  let architectToken: string | undefined;
  if (!fieldToken) {
    const architect = core.fieldTokens.issue({ tenantId, principal: "architect" });
    architectToken = architect.token;
    fieldToken = core.fieldTokens.issue({
      tenantId,
      principal: "field",
      presented: architect.token,
    }).token;
  }
  const server = new FieldHttpServer({ core, pack, tenantId });
  servers.push(server);
  const { url } = await server.listen(0, "127.0.0.1");
  return {
    server,
    url,
    fieldToken,
    field: new FieldClient(url, fieldToken),
    core,
    pack,
    architectToken,
  };
}

async function habitatGrantStack(tenantId = "grant-restart") {
  const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-grants-hab-"));
  const { anchors, binding } = await signedGenericPack();
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir, {
    adapter: new DryStemAdapter(),
  });
  const loaded = core.packs.load({ tenantId, binding, actor: "architect" });
  if (!loaded.ok) throw new Error(loaded.message);
  const agents = core.agents.instantiateFromPack(loaded.loaded, "architect");
  const record = core.records.put(tenantId, { type: "case", label: "Subject" });
  const world = await useWorldHttp();
  const architect = core.fieldTokens.issue({ tenantId, principal: "architect" });
  bindWorldForPack({
    tenantId,
    computerBaseDir,
    architectToken: architect.token,
    pack: loaded.loaded,
    baseUrl: world.url,
  });
  return {
    computerBaseDir,
    anchors,
    core,
    pack: loaded.loaded,
    tenantId,
    agents,
    record,
    world,
  };
}

describe("durable authorized grants on tenant computer disk", () => {
  it("keeps the RE fixture pin at 5091328 and does not invent T0–T3", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const files = [
      "src/grants/ask.ts",
      "src/grants/store.ts",
      "src/grants/grant-store.ts",
      "src/effects/executor.ts",
      "src/policy/gateway.ts",
      "src/kernel.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(src).not.toMatch(/\bT0\b|\bT1\b|\bT2\b|\bT3\b/);
      expect(src).not.toMatch(/VEYRA|Architect Desktop|NemoClaw|DEC-017 is accepted/);
    }
    const kernel = readFileSync(path.join(process.cwd(), "src/kernel.ts"), "utf8");
    expect(kernel).toMatch(/new GrantBook\(computerBaseDir\)/);
    const store = readFileSync(path.join(process.cwd(), "src/grants/store.ts"), "utf8");
    expect(store).toMatch(/loadGrantStore/);
    expect(store).toMatch(/saveGrantStore/);
    expect(store).toMatch(/grantsFile/);
    const persist = readFileSync(path.join(process.cwd(), "src/grants/grant-store.ts"), "utf8");
    expect(persist).toMatch(/readJsonFileStrict/);
    expect(persist).toMatch(/writeJsonAtomic/);
    const gateway = readFileSync(path.join(process.cwd(), "src/policy/gateway.ts"), "utf8");
    expect(gateway).toMatch(/EXC-008/);
    const executor = readFileSync(path.join(process.cwd(), "src/effects/executor.ts"), "utf8");
    expect(executor).toMatch(/this\.gateway\.decide/);
  });

  it("reloads the same authorized grant from the tenant disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-grants-"));
    const first = new GrantBook(dir);
    const written = authorize(first, "t1", "agent_follow");

    const paths = computerRoot(dir, "t1");
    expect(existsSync(paths.grantsFile)).toBe(true);
    expect(paths.grantsFile).toBe(path.join(dir, "tenants", "t1", "grants.json"));
    expect(existsSync(path.join(paths.disk, "grants.json"))).toBe(false);

    const second = new GrantBook(dir);
    expect(second.classState("t1", "communicate")).toBe("authorized");
    expect(second.authorizedForClass("t1", "communicate")?.grantId).toBe(written.grantId);
    expect(second.get("t1", "agent_follow", "communicate")?.state).toBe("authorized");
    expect(habitatAskReason({ grants: second, tenantId: "t1", actionClass: "communicate" })).toBeUndefined();
  });

  it("write grant → restart kernel/habitat → grant is still present and used", async () => {
    const first = await habitatGrantStack();
    const orch = first.agents.find((a) => a.isOrchestrator)!;
    const written = authorize(first.core.grants, first.tenantId, orch.agentId);
    expect(first.core.grants.classState(first.tenantId, "communicate")).toBe("authorized");

    const second = new AlphaVectorCore(
      first.anchors,
      path.join(first.computerBaseDir, "state"),
      first.computerBaseDir,
      { adapter: new DryStemAdapter() },
    );
    const pack = second.packs.active(first.tenantId);
    expect(second.grants.classState(first.tenantId, "communicate")).toBe("authorized");
    expect(second.grants.authorizedForClass(first.tenantId, "communicate")?.grantId).toBe(written.grantId);
    expect(
      habitatAskReason({ grants: second.grants, tenantId: first.tenantId, actionClass: "communicate" }),
    ).toBeUndefined();

    const beforeInbox = second.cards.fieldInbox(first.tenantId).length;
    const started = await second.habitat.wake({
      kind: "field_start",
      tenantId: first.tenantId,
      pack,
      goal: "one goal",
      recordId: first.record.id,
    });
    expect(started.cardId).toBeUndefined();
    expect(started.effect?.executed).toBe(true);
    expect(started.effect?.policyDecision).toBeTruthy();
    expect(second.cards.fieldInbox(first.tenantId)).toHaveLength(beforeInbox);
    expect(second.store.actions.some((a) => a.status === "executed")).toBe(true);
    expect(first.world.requests).toHaveLength(1);
    expect(recordedSendOf(first.world.requests[0]?.body)).toEqual({
      ...WORLD_FIXTURE_SEND,
      channel: "email",
    });
  });

  it("field cannot write or persist a grant", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-grants-field-"));
    const book = new GrantBook(dir);
    expect(() =>
      book.write({
        actor: "field",
        tenantId: "t1",
        agentId: "agent_follow",
        actionClass: "communicate",
        state: "authorized",
        bounds: {},
        owner: "field",
        evidenceIds: ["ev1"],
        evalIds: ["eval1"],
        fieldNotice: "nope",
      }),
    ).toThrow(SurfaceViolationError);
    expect(existsSync(computerRoot(dir, "t1").grantsFile)).toBe(false);
    expect(book.list("t1")).toEqual([]);

    const live = await liveDurable("field-grant", dir);
    await createOpenStart(live.field, "buyer", "Work this buyer journey");
    expect(existsSync(computerRoot(dir, "field-grant").grantsFile)).toBe(false);
    expect(live.core.grants.list("field-grant")).toEqual([]);
    expect(live.core.grants.classState("field-grant", "communicate")).toBe("requires_authorization");
  });

  it("field kill persists revoke; field still cannot graduate", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-grants-kill-"));
    const first = new GrantBook(dir);
    authorize(first, "t1", "agent_follow");
    first.kill({ tenantId: "t1", actionClass: "communicate", reason: "owner kill" });

    const second = new GrantBook(dir);
    expect(second.classState("t1", "communicate")).toBe("revoked");
    expect(second.authorizedForClass("t1", "communicate")).toBeUndefined();
    expect(habitatAskReason({ grants: second, tenantId: "t1", actionClass: "communicate" })).toBe(
      "grant_revoked",
    );
    expect(() =>
      second.write({
        actor: "field",
        tenantId: "t1",
        agentId: "agent_follow",
        actionClass: "communicate",
        state: "authorized",
        bounds: { channels: ["email"] },
        owner: "field",
        evidenceIds: ["ev1"],
        evalIds: ["eval1"],
        fieldNotice: "nope",
      }),
    ).toThrow(/cannot create, widen, or graduate/);
    expect(second.classState("t1", "communicate")).toBe("revoked");
  });

  it("missing store is an empty book and does not invent a grant", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-grants-miss-"));
    const book = new GrantBook(dir);
    expect(book.list("t1")).toEqual([]);
    expect(book.classState("t1", "communicate")).toBe("requires_authorization");
    expect(book.authorizedForClass("t1", "communicate")).toBeUndefined();
    expect(habitatAskReason({ grants: book, tenantId: "t1", actionClass: "communicate" })).toBe("no_grant");

    const live = await liveDurable("missing", dir);
    expect(live.core.grants.list("missing")).toEqual([]);
    expect(live.core.grants.classState("missing", "communicate")).toBe("requires_authorization");
  });

  it("corrupt store refuses and does not silently empty into no grants", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-grants-bad-"));
    const paths = computerRoot(dir, "t1");
    await mkdir(path.dirname(paths.grantsFile), { recursive: true });
    await writeFile(paths.grantsFile, "{not-json", "utf8");

    const book = new GrantBook(dir);
    expect(() => book.classState("t1", "communicate")).toThrow(AvError);
    expect(() => book.classState("t1", "communicate")).toThrow(/corrupt/i);
    expect(() => book.list("t1")).toThrow(/GRANT_STORE_CORRUPT|corrupt/i);
    expect(() => habitatAskReason({ grants: book, tenantId: "t1", actionClass: "communicate" })).toThrow(
      /corrupt/i,
    );

    const guessed = await mkdtemp(path.join(os.tmpdir(), "av-grants-guess-"));
    const guessPath = computerRoot(guessed, "corrupt");
    await mkdir(path.dirname(guessPath.grantsFile), { recursive: true });
    await writeFile(
      guessPath.grantsFile,
      JSON.stringify({ grants: [{ actionClass: "communicate", state: "authorized" }] }),
      "utf8",
    );
    const guessedBook = new GrantBook(guessed);
    expect(() => guessedBook.classState("corrupt", "communicate")).toThrow(/corrupt/i);
    expect(() => guessedBook.authorizedForClass("corrupt", "communicate")).toThrow(/corrupt/i);

    const live = await liveDurable("corrupt", guessed);
    await expect(live.field.home()).rejects.toMatchObject({
      status: 500,
      code: "GRANT_STORE_CORRUPT",
    });
  });
});
