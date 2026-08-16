import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computerRoot } from "../src/computer/paths.js";
import { CORE_SCHEMA_SQL } from "../src/data/sql.js";
import { FactBook } from "../src/facts/book.js";
import { RecordBook } from "../src/records/book.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import { reapHeldCoders } from "../src/habitat/index.js";
import { FieldClient, FieldHttpError } from "../src/http/field-client.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { AlphaVectorCore } from "../src/kernel.js";
import type { PackBinding } from "../src/packs/types.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  createOpenStart,
  expectPresentIdsDeniedWithoutRecord,
  signedRePackMutated,
} from "./helpers.js";
import { bindWorldForPack, closeWorldHttp, useWorldHttp } from "./world-double.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const REQUIRED = "condition.required";
const servers: FieldHttpServer[] = [];

/** Unique purpose.* from pack REQUIRES/PREFERS. Does not read AVOIDS. */
function collectPurposeFactIds(binding: PackBinding): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const take = (values: string[] | undefined) => {
    for (const id of values ?? []) {
      if (id.startsWith("purpose.") && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  };
  for (const verb of binding.actionClassVerbs) {
    take(verb.REQUIRES);
    take(verb.PREFERS);
  }
  for (const kind of binding.journeyKinds) {
    take(kind.REQUIRES);
    take(kind.PREFERS);
  }
  return ids;
}

/** Unique AVOIDS from pack journeyKinds and actionClassVerbs. Does not read REQUIRES/PREFERS. */
function collectAvoidFactIds(binding: PackBinding): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const take = (values: string[] | undefined) => {
    for (const id of values ?? []) {
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  };
  for (const verb of binding.actionClassVerbs) {
    take(verb.AVOIDS);
  }
  for (const kind of binding.journeyKinds) {
    take(kind.AVOIDS);
  }
  return ids;
}

function communicateAvoidFromHome(
  home: { avoidFacts: Array<{ id: string; label: string }> },
  pack: { binding: PackBinding },
): { id: string; label: string } {
  const communicateAvoids =
    pack.binding.actionClassVerbs.find((v) => v.id === "communicate")?.AVOIDS ?? [];
  const avoided = home.avoidFacts.find((f) => f.id === communicateAvoids[0]);
  if (!avoided) throw new Error("loaded pack has no communicate AVOIDS on home");
  return avoided;
}

/** Markup characters that must be escaped in HTML, not a reproduction procedure. */
const FIELD_HTML_FIXTURE = "<em>x</em>";
const FIELD_HTML_ESCAPED = "&lt;em&gt;x&lt;/em&gt;";

function fieldPageScript(html: string): string {
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("field page script missing");
  return script;
}

function fieldPageFn<T>(html: string, name: string): T {
  const match = fieldPageScript(html).match(new RegExp(`function ${name}\\([\\s\\S]*?\\n    \\}`));
  if (!match) throw new Error(`${name} missing from field page`);
  return new Function(`${match[0]}; return ${name};`)() as T;
}

function fieldPageListTemplate(html: string, listId: string): string {
  const match = fieldPageScript(html).match(
    new RegExp(`renderList\\("${listId}",[\\s\\S]*?=>\\s*\`([\\s\\S]*?)\`\\s*\\)`),
  );
  if (!match?.[1]) throw new Error(`renderList template for ${listId} missing`);
  return match[1];
}

function renderFieldList(
  html: string,
  listId: string,
  rowParam: string,
  row: unknown,
  selectedRecordId = "",
): string {
  const escapeHtml = fieldPageFn<(value: unknown) => string>(html, "escapeHtml");
  const attributePairs = fieldPageFn<(attributes: Record<string, string> | undefined) => string>(
    html,
    "attributePairs",
  );
  const template = fieldPageListTemplate(html, listId);
  const render = new Function(
    "escapeHtml",
    "attributePairs",
    "selectedRecordId",
    rowParam,
    `return \`${template}\`;`,
  );
  return render(escapeHtml, attributePairs, selectedRecordId, row) as string;
}

function expectEscapedInterpolation(rendered: string) {
  expect(rendered).toContain(FIELD_HTML_ESCAPED);
  expect(rendered).not.toContain(FIELD_HTML_FIXTURE);
}

afterEach(async () => {
  reapHeldCoders();
  await closeWorldHttp();
  while (servers.length) {
    await servers.pop()?.close();
  }
});

async function liveField(tenantId = "t1", computerBaseDir?: string) {
  const dir = computerBaseDir ?? (await mkdtemp(path.join(os.tmpdir(), "av-field-http-")));
  const { core, pack } = await bootFieldCore(tenantId, {
    computerBaseDir: dir,
    adapter: new DryStemAdapter(),
  });
  const architectIssued = core.fieldTokens.issue({ tenantId, principal: "architect" });
  const fieldIssued = core.fieldTokens.issue({
    tenantId,
    principal: "field",
    presented: architectIssued.token,
  });
  const tokens = { field: fieldIssued.token, architect: architectIssued.token };
  const server = new FieldHttpServer({ core, pack, tenantId });
  servers.push(server);
  const { url } = await server.listen(0, "127.0.0.1");
  return {
    url,
    tenantId,
    tokens,
    fieldIssued,
    field: new FieldClient(url, tokens.field),
    architect: new FieldClient(url, tokens.architect),
    core,
    pack,
    computerBaseDir: dir,
  };
}

async function liveFieldWithWorld(tenantId = "t1", computerBaseDir?: string) {
  const stack = await liveField(tenantId, computerBaseDir);
  const world = await useWorldHttp();
  bindWorldForPack({
    tenantId: stack.tenantId,
    computerBaseDir: stack.computerBaseDir,
    architectToken: stack.tokens.architect,
    pack: stack.pack,
    baseUrl: world.url,
  });
  return { ...stack, world };
}

async function liveMutatedField(
  tenantId: string,
  computerBaseDir: string,
  mutate: (unsigned: Omit<PackBinding, "signatures">) => void,
) {
  const { anchors, binding } = await signedRePackMutated(mutate);
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir, {
    adapter: new DryStemAdapter(),
  });
  const loaded = core.packs.load({ tenantId, binding, actor: "architect" });
  if (!loaded.ok) throw new Error(loaded.message);
  if (core.agents.list(tenantId).length === 0) {
    core.agents.instantiateFromPack(loaded.loaded, "architect");
  }
  const architectIssued = core.fieldTokens.issue({ tenantId, principal: "architect" });
  const fieldIssued = core.fieldTokens.issue({
    tenantId,
    principal: "field",
    presented: architectIssued.token,
  });
  const tokens = { field: fieldIssued.token, architect: architectIssued.token };
  const server = new FieldHttpServer({ core, pack: loaded.loaded, tenantId });
  servers.push(server);
  const { url } = await server.listen(0, "127.0.0.1");
  return {
    url,
    tenantId,
    tokens,
    field: new FieldClient(url, tokens.field),
    architect: new FieldClient(url, tokens.architect),
    core,
    pack: loaded.loaded,
  };
}

async function issueFactCard(field: FieldClient, id: string, recordId: string): Promise<string> {
  return field.requestFactCard(id, "record", recordId);
}

describe("field HTTP surface against pinned alphavector-re", () => {
  it("keeps the RE fixture pin at 5091328", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
  });

  it("starts a buyer journey on the field API", async () => {
    const { field, pack } = await liveField();
    expect(pack.binding.journeyKinds.map((k) => k.id)).toEqual([
      "buyer",
      "seller",
      "listing",
      "transaction",
      "past-client",
    ]);
    const home = await field.home();
    expect(home.journeys).toEqual([]);
    expect(home.architectControls).toEqual([]);
    expect(home.journeyKinds.map((k) => k.id)).toEqual(pack.binding.journeyKinds.map((k) => k.id));
    expect(home.purposeFacts.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "purpose.follow-up",
        "purpose.showing",
        "purpose.listing",
        "purpose.transaction",
      ]),
    );
    expect(home.purposeFacts).toHaveLength(4);
    expect(home.avoidFacts.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "consent.dnc",
        "consent.quiet-hours",
        "consent.assumed-autonomy",
        "consent.crm-update",
        "consent.recovery",
        "consent.scheduling",
      ]),
    );
    expect(home.avoidFacts).toHaveLength(6);
    expect(home.records).toEqual([]);
    expect(home.recordKinds.map((k) => k.id)).toEqual([
      ...pack.binding.recordPartyKnowledge.recordKinds,
      ...pack.binding.recordPartyKnowledge.partyKinds,
    ]);
    expect(home.recordKinds.every((k) => k.id && k.label)).toBe(true);
    const { journey, record } = await createOpenStart(field, "buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");
    expect(journey.status).toBe("open");
    expect(journey.recordId).toBe(record.id);
    const after = await field.home();
    expect(after.journeys.map((j) => j.kind)).toContain("buyer");
    expect(after.records.map((r) => r.id)).toContain(record.id);
  });

  it("approves an owner card then executes", async () => {
    const { field } = await liveFieldWithWorld("approve");
    const done = await field.completeBuyerJourneyAndCard();
    expect(done.effect.executed).toBe(true);
    const home = await field.home();
    expect(home.inbox).toHaveLength(0);
    expect(home.outboundLog.some((row) => row.actionId === done.effect.actionId)).toBe(true);
    expect(JSON.stringify(home)).not.toMatch(/architect_admin|T0|T1|T2|T3/i);
  });

  it("keeps an Ask ceiling deny denied on retry", async () => {
    const { field } = await liveField("ask");
    const req = { text: "give a licensed price opinion", actionClass: "licensed_judgment" };
    await expect(field.ask(req.text, req.actionClass)).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/Ask ceiling/),
    });
    await expect(field.ask(req.text, req.actionClass)).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/Ask ceiling/),
    });
  });

  it("denies missing, unknown, and demo field tokens", async () => {
    const { url, tenantId, field } = await liveField("deny");
    const start = { journeyKind: "buyer", objective: "Work this buyer journey" };
    for (const headers of [
      {},
      { authorization: "Bearer " },
      { authorization: "Bearer field-dev-token" },
      { authorization: `Bearer field-${tenantId}` },
      { authorization: "Bearer not-issued" },
    ]) {
      const res = await fetch(`${url}/field/journeys`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(start),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("UNAUTHORIZED");
    }
    const started = await createOpenStart(field, "buyer", "Work this buyer journey");
    expect(started.journey.journeyKind).toBe("buyer");
  });

  it("denies a revoked issued token and does not invent a session", async () => {
    const { url, tenantId, fieldIssued, core, field, tokens } = await liveField("revoke");
    const started = await createOpenStart(field, "buyer", "Work this buyer journey");
    const journey = started.journey;
    expect(journey.status).toBe("open");
    core.fieldTokens.revoke({
      tenantId,
      tokenId: fieldIssued.tokenId,
      presented: tokens.architect,
    });
    const res = await fetch(`${url}/field/journeys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fieldIssued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ journeyKind: "buyer", objective: "Revoked must not start" }),
    });
    expect(res.status).toBe(401);
    await expect(field.start("buyer", "Revoked must not start", "rec_none")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("rejects Architect credentials on field start", async () => {
    const { architect, field } = await liveField("authz");
    await expect(
      architect.start("buyer", "Architect must not use this path", "rec_none"),
    ).rejects.toBeInstanceOf(FieldHttpError);
    await expect(
      architect.start("buyer", "Architect must not use this path", "rec_none"),
    ).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
      message: expect.stringMatching(/field user/),
    });
    await expect(architect.open("buyer", "rec_none")).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
      message: expect.stringMatching(/field user/),
    });
    await expect(architect.record("journey.buyer", "rec_none")).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    const started = await createOpenStart(field, "buyer", "Work this buyer journey");
    expect(started.journey.journeyKind).toBe("buyer");
  });

  it("does not expose Architect, models, prompts, Temporal, or tools on field routes", async () => {
    const { url, tokens } = await liveField("closed");
    const headers = { authorization: `Bearer ${tokens.field}` };
    for (const path of [
      "/field/models",
      "/field/prompts",
      "/field/temporal",
      "/field/tools",
      "/field/adapter-credentials",
      "/field/connector-credentials",
      "/field/credentials",
      "/field/api-key",
      "/field/vendor-base-url",
      "/field/base-url",
      "/field/routines",
      "/field/mail",
      "/field/deadlines",
      "/field/connectors",
      "/field/skills",
      "/field/memory",
      "/field/memory-store",
    ]) {
      const res = await fetch(`${url}${path}`, { headers });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/cannot configure models, prompts, Temporal, or tools/);
    }
    for (const path of ["/architect", "/field/architect", "/admin", "/field/packs"]) {
      const res = await fetch(`${url}${path}`, { method: "POST", headers });
      expect(res.status).toBe(404);
    }
  });

  it("serves a Linux-openable field client that can complete a journey and a card", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-linux-page-"));
    const { url, field, tokens, tenantId, pack } = await liveFieldWithWorld("linux", dir);
    const page = await fetch(url);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    const html = await page.text();
    expect(html).toMatch(/Start journey/);
    expect(html).toMatch(/data-approve/);
    expect(html).toMatch(/\/field\/journeys/);
    expect(html).toMatch(/\/field\/cards/);
    expect(html).toMatch(/id="fact-id"/);
    expect(html).toMatch(/id="record"/);
    expect(html).toMatch(/id="retract"/);
    expect(html).toMatch(/\/field\/facts/);
    expect(html).toMatch(/\/field\/facts\/retract/);
    expect(html).toMatch(/id="journey-kinds"/);
    expect(html).toMatch(/home\.journeyKinds/);
    expect(html).toMatch(/function escapeHtml\(/);
    expect(html).toMatch(/el\.innerHTML = rows\.length \? rows\.map\(html\)\.join\(""\)/);
    expect(html).toMatch(/data-open=/);
    expect(html).toMatch(/>Open</);
    expect(html).toMatch(/"journey\." \+ t\.dataset\.open/);
    expect(html).toMatch(
      /requestFactCard\("journey\." \+ t\.dataset\.open, "\/field\/facts", selectedRecord\(\)\)/,
    );
    expect(html).toMatch(/recordId:\s*selectedRecord\(\)/);
    expect(html).toMatch(/if\s*\(\s*!selectedRecord\(\)\s*\)/);
    expect(html).toMatch(/Select a record before starting/);
    expect(html).toMatch(/Select a record before opening/);
    expect(html).toMatch(/Select a record before recording a purpose/);
    expect(html).toMatch(/Select a record before recording an avoid/);
    expect(html).toMatch(/Select a record before retracting an avoid/);
    expect(html).toMatch(/Select a record before recording a fact/);
    expect(html).toMatch(/Select a record before retracting a fact/);
    expect(html).toMatch(/Select a record before requesting follow-up/);
    expect(html).not.toMatch(/selectedRecord\(\) \|\| t\.dataset\.kind/);
    expect(html).toMatch(/subject:\s*selectedRecord\(\)/);
    expect(html).toMatch(/id="purpose-facts"/);
    expect(html).toMatch(/home\.purposeFacts/);
    expect(html).toMatch(/data-purpose=/);
    expect(html).toMatch(/t\.dataset\.purpose/);
    expect(html).toMatch(/id="avoid-facts"/);
    expect(html).toMatch(/home\.avoidFacts/);
    expect(html).toMatch(/data-avoid=/);
    expect(html).toMatch(/data-avoid-retract=/);
    expect(html).toMatch(/t\.dataset\.avoid/);
    expect(html).toMatch(/t\.dataset\.avoidRetract/);
    expect(html).toMatch(/id="records"/);
    expect(html).toMatch(/id="create-record"/);
    expect(html).toMatch(/\/field\/records/);
    expect(html).toMatch(/\/field\/records\/update/);
    expect(html).toMatch(/id="attr-key"/);
    expect(html).toMatch(/id="attr-value"/);
    expect(html).toMatch(/id="set-attribute"/);
    expect(html).toMatch(/id="record-attributes"/);
    expect(html).toMatch(/Select a record before setting an attribute/);
    expect(html).toMatch(/\/field\/records\/attributes\/retract/);
    expect(html).toMatch(/data-attr-retract=/);
    expect(html).toMatch(/Select a record before retracting an attribute/);
    expect(html).toMatch(/id="retract-record"/);
    expect(html).toMatch(/\/field\/records\/retract/);
    expect(html).toMatch(/Select a record before retracting a record/);
    expect(html).toMatch(/home\.recordKinds/);
    expect(html).toMatch(/home\.records/);
    expect(html).toMatch(/data-select-record=/);
    expect(html).not.toMatch(/id="phone"|id="email"|id="mls"/);
    expect(html).not.toMatch(/for="phone"|for="email"|for="mls"/);
    expect(html).not.toMatch(/>Phone<|>Email<|>MLS</);
    expect(html).not.toMatch(/purpose\.follow-up/);
    expect(html).not.toMatch(/purpose\.showing|purpose\.listing|purpose\.transaction/);
    expect(html).not.toMatch(/consent\.dnc/);
    expect(html).not.toMatch(
      /consent\.quiet-hours|consent\.assumed-autonomy|consent\.crm-update|consent\.recovery|consent\.scheduling/,
    );
    expect(html).not.toMatch(/journey\.buyer/);
    expect(html).not.toMatch(/k\.id === ["']buyer["']/);
    expect(html).not.toContain("Work this buyer journey");
    expect(html).not.toMatch(/selected=["']buyer["']/);
    expect(html).not.toMatch(/listing_id|person_id|household_id|buyer_id/i);
    expect(html).not.toContain(tokens.field);
    expect(html).not.toMatch(/window\.FIELD_DEFAULTS/);
    expect(html).toMatch(/Issued field token/);
    expect(html).toMatch(/Paste a token Architect issued/);
    expect(html).not.toContain("field-dev-token");
    expect(html).not.toContain(`field-${tenantId}`);
    expect(html).not.toMatch(/architectControls|pick a model|edit prompt|inspect temporal|configure tool/i);
    expect(html).not.toMatch(/id="routine"|id="routines"|bind-routine|author routine/i);
    expect(html).not.toMatch(/id="deadline"|id="deadlines"|bind-deadline|author deadline/i);
    expect(html).not.toMatch(/id="connector"|id="connectors"|bind-connector|author connector/i);
    expect(html).not.toMatch(/Desk|Shape|Director|Play|Plant|HIL|Thor|Mission Control/);

    const clientSrc = await readFile(path.join(REPO_ROOT, "src/http/field-client.ts"), "utf8");
    expect(clientSrc).not.toMatch(/purpose\.follow-up/);
    expect(clientSrc).not.toMatch(/consent\.dnc/);
    expect(clientSrc).toMatch(/home\.purposeFacts/);
    expect(clientSrc).toMatch(/recordApprovedFact\(purpose\.id/);
    expect(clientSrc).toMatch(/requestFactCard/);
    expect(clientSrc).toMatch(/recordApprovedFact/);
    expect(clientSrc).toMatch(/createApprovedRecord/);
    expect(clientSrc).toMatch(/updateApprovedRecord/);
    expect(clientSrc).toMatch(/requestRecordUpdateCard/);
    expect(clientSrc).toMatch(/\/field\/records\/update/);
    expect(clientSrc).toMatch(/requestRecordRetractCard/);
    expect(clientSrc).toMatch(/retractApprovedRecord/);
    expect(clientSrc).toMatch(/\/field\/records\/retract/);
    expect(clientSrc).toMatch(/home\.recordKinds/);
    expect(clientSrc).toMatch(/openApproved\(kind\.id, subject\.id\)/);
    expect(clientSrc).toMatch(/start\(kind\.id, `Work this \$\{kind\.label\} journey`, subject\.id\)/);
    expect(clientSrc).toMatch(/start\(journeyKind: string, objective: string, recordId: string\)/);
    expect(clientSrc).toMatch(/open\(kindId: string, recordId: string\)/);
    expect(clientSrc).toMatch(/record\(id: string, recordId: string\)/);
    expect(clientSrc).toMatch(/retract\(id: string, recordId: string\)/);
    expect(clientSrc).toMatch(/completeFactRecordAndRetract\(/);
    expect(clientSrc).toMatch(/recordId: string/);
    const fieldSrc = await readFile(path.join(REPO_ROOT, "src/surfaces/field.ts"), "utf8");
    expect(fieldSrc).not.toMatch(/consent\.dnc/);
    expect(fieldSrc).toMatch(/avoidFactsFromBinding/);
    expect(fieldSrc).toMatch(/recordKindsFromBinding/);
    expect(fieldSrc).toMatch(/assertRecordUpdatePatch/);
    expect(fieldSrc).toMatch(/actionClass === "update"/);
    expect(fieldSrc).toMatch(/actionClass === "delete"/);
    expect(fieldSrc).toMatch(/retractRecord/);
    expect(fieldSrc).toMatch(/this\.facts\.presentIds\(card\.tenantId, recordId\)/);
    expect(fieldSrc).toMatch(/this\.facts\.retract\(card\.tenantId, factId, recordId\)/);
    expect(fieldSrc).toMatch(/verb\.AVOIDS/);
    expect(fieldSrc).toMatch(/kind\.AVOIDS/);
    expect(fieldSrc).toMatch(/RECORD_ID_REQUIRED/);
    expect(fieldSrc).toMatch(/assertKnownRecord\(input\.pack\.tenantId, input\.recordId\)/);
    expect(fieldSrc).toMatch(/assertKnownRecord\(tenantId, subject\)/);
    expect(fieldSrc).not.toMatch(/this\.facts\.presentIds\(tenantId\)\s*;/);
    expect(fieldSrc).not.toMatch(/listing_id|person_id|household_id|buyer_id/);
    const bookSrc = await readFile(path.join(REPO_ROOT, "src/facts/book.ts"), "utf8");
    expect(bookSrc).not.toMatch(/const GLOBAL/);
    expect(bookSrc).not.toMatch(/recordId \?\? GLOBAL/);
    expect(bookSrc).not.toMatch(/if \(!fact\.recordId\) continue/);
    expect(bookSrc).toMatch(/RECORD_ID_REQUIRED/);
    expect(bookSrc).toMatch(/presentIds\(tenantId: string, recordId: string\)/);
    expect(bookSrc).toMatch(/put\(tenantId: string, id: string, recordId: string\)/);
    expect(bookSrc).toMatch(/retract\(tenantId: string, id: string, recordId: string\)/);

    const home = await field.home();
    expect(home.journeyKinds.map((k) => k.id)).toEqual(pack.binding.journeyKinds.map((k) => k.id));
    expect(home.journeyKinds.every((k) => k.id && k.label)).toBe(true);
    expect(home.purposeFacts.map((f) => f.id).sort()).toEqual(
      collectPurposeFactIds(pack.binding).sort(),
    );
    expect(home.purposeFacts.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "purpose.follow-up",
        "purpose.showing",
        "purpose.listing",
        "purpose.transaction",
      ]),
    );
    expect(home.purposeFacts.every((f) => f.id && f.label)).toBe(true);
    expect(home.purposeFacts.find((f) => f.id === "purpose.follow-up")?.label).toBe(
      pack.binding.fieldLanguageMap["purpose.follow-up"],
    );
    expect(home.avoidFacts.map((f) => f.id).sort()).toEqual(collectAvoidFactIds(pack.binding).sort());
    expect(home.avoidFacts.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "consent.dnc",
        "consent.quiet-hours",
        "consent.assumed-autonomy",
        "consent.crm-update",
        "consent.recovery",
        "consent.scheduling",
      ]),
    );
    expect(home.avoidFacts.every((f) => f.id && f.label)).toBe(true);
    expect(home.avoidFacts.find((f) => f.id === "consent.dnc")?.label).toBe(
      pack.binding.fieldLanguageMap["consent.dnc"] ?? "consent.dnc",
    );
    expect(home.records).toEqual([]);
    expect(home.recordKinds.map((k) => k.id)).toEqual([
      ...pack.binding.recordPartyKnowledge.recordKinds,
      ...pack.binding.recordPartyKnowledge.partyKinds,
    ]);
    expect(home.recordKinds.every((k) => k.id && k.label)).toBe(true);
    const communicateRequires = pack.binding.actionClassVerbs.find((v) => v.id === "communicate")
      ?.REQUIRES;
    expect(communicateRequires?.some((id) => id.startsWith("purpose."))).toBe(true);
    expect(home.purposeFacts[0]?.id).toBe(communicateRequires?.find((id) => id.startsWith("purpose.")));

    const done = await field.completeBuyerJourneyAndCard();
    expect(done.journey.journeyKind).toBe("buyer");
    expect(done.effect.executed).toBe(true);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    const subject = (await field.home()).records[0];
    expect(subject?.id).toMatch(/^rec_/);
    expect(done.journey.recordId).toBe(subject!.id);
    expect(new FactBook(dir).presentIds(tenantId, subject!.id)).toEqual(
      expect.arrayContaining(["journey.buyer", "purpose.follow-up"]),
    );
    for (const id of collectAvoidFactIds(pack.binding)) {
      expect(new FactBook(dir).presentIds(tenantId, subject!.id)).not.toContain(id);
    }

    // Same POSTs the page script issues: record/retract then existing card approve.
    const paths = computerRoot(dir, tenantId);
    expect(existsSync(paths.recordsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "records.json"))).toBe(false);
    const recordCardId = await field.requestFactCard(REQUIRED, "record", subject!.id);
    expect(existsSync(paths.factsFile)).toBe(true);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    const recorded = await field.approve(recordCardId);
    expect(recorded.fact).toEqual({ id: REQUIRED, present: true, recordId: subject!.id });
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8")).facts).toEqual(
      expect.arrayContaining([
        { id: "journey.buyer", recordId: subject!.id },
        { id: "purpose.follow-up", recordId: subject!.id },
        { id: REQUIRED, recordId: subject!.id },
      ]),
    );
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);

    const retractCardId = await field.requestFactCard(REQUIRED, "retract", subject!.id);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, subject!.id)).toEqual(
      expect.arrayContaining(["journey.buyer", "purpose.follow-up", REQUIRED]),
    );
    const retracted = await field.approve(retractCardId);
    expect(retracted.fact).toEqual({ id: REQUIRED, present: false, recordId: subject!.id });
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, subject!.id)).toEqual(
      expect.arrayContaining(["journey.buyer", "purpose.follow-up"]),
    );
    expect(new FactBook(dir).presentIds(tenantId, subject!.id)).not.toContain(REQUIRED);

    const scripted = await field.completeFactRecordAndRetract("demo.fact", subject!.id);
    expect(scripted.recorded).toEqual({ id: "demo.fact", present: true, recordId: subject!.id });
    expect(scripted.retracted).toEqual({ id: "demo.fact", present: false, recordId: subject!.id });
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, subject!.id)).toEqual(
      expect.arrayContaining(["journey.buyer", "purpose.follow-up"]),
    );
    expect(new FactBook(dir).presentIds(tenantId, subject!.id)).not.toContain("demo.fact");
  });

  it("escapes interpolated field values in the Linux page innerHTML", async () => {
    const { url, field } = await liveField("escape-html");
    const html = await (await fetch(url)).text();
    expect(html).toMatch(/function escapeHtml\(/);
    expect(html).toMatch(/el\.innerHTML = rows\.length \? rows\.map\(html\)\.join\(""\)/);
    expect(html).toMatch(/\$\{escapeHtml\(k\.label\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(r\.label\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(attributePairs\(r\.attributes\)\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(a\.key\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(a\.value\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(p\.label\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(j\.objective\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(c\.purpose\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(c\.subject\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(c\.channel\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(c\.approve\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(c\.deny\)\}/);
    expect(html).toMatch(/\$\{escapeHtml\(o\.summary\)\}/);
    const interpolations = [...fieldPageScript(html).matchAll(/\$\{([^}]+)\}/g)].map((m) =>
      m[1].trim(),
    );
    expect(interpolations.length).toBeGreaterThan(0);
    for (const expr of interpolations) {
      expect(expr.startsWith("escapeHtml(")).toBe(true);
      expect(expr.endsWith(")")).toBe(true);
    }

    const home = await field.home();
    const rec = await field.createApprovedRecord(home.recordKinds[0]!.id, FIELD_HTML_FIXTURE);
    const updated = await field.updateApprovedRecord(rec.id, {
      attributes: { [FIELD_HTML_FIXTURE]: FIELD_HTML_FIXTURE },
    });
    expect(updated.label).toBe(FIELD_HTML_FIXTURE);
    expect(updated.attributes[FIELD_HTML_FIXTURE]).toBe(FIELD_HTML_FIXTURE);
    const listed = (await field.home()).records.find((r) => r.id === rec.id);
    expect(listed?.label).toBe(FIELD_HTML_FIXTURE);
    expect(listed?.attributes[FIELD_HTML_FIXTURE]).toBe(FIELD_HTML_FIXTURE);

    expectEscapedInterpolation(renderFieldList(html, "records", "r", listed, rec.id));
    expectEscapedInterpolation(
      renderFieldList(html, "record-attributes", "a", {
        key: FIELD_HTML_FIXTURE,
        value: FIELD_HTML_FIXTURE,
      }),
    );
    expectEscapedInterpolation(
      renderFieldList(html, "journey-kinds", "k", { id: FIELD_HTML_FIXTURE, label: FIELD_HTML_FIXTURE }),
    );
    expectEscapedInterpolation(
      renderFieldList(html, "purpose-facts", "p", { id: FIELD_HTML_FIXTURE, label: FIELD_HTML_FIXTURE }),
    );
    expectEscapedInterpolation(
      renderFieldList(html, "avoid-facts", "a", { id: FIELD_HTML_FIXTURE, label: FIELD_HTML_FIXTURE }),
    );
    expectEscapedInterpolation(
      renderFieldList(html, "journeys", "j", {
        kind: FIELD_HTML_FIXTURE,
        objective: FIELD_HTML_FIXTURE,
        id: FIELD_HTML_FIXTURE,
      }),
    );
    expectEscapedInterpolation(
      renderFieldList(html, "cards", "c", {
        purpose: FIELD_HTML_FIXTURE,
        subject: FIELD_HTML_FIXTURE,
        channel: FIELD_HTML_FIXTURE,
        cardId: FIELD_HTML_FIXTURE,
        approve: FIELD_HTML_FIXTURE,
        deny: FIELD_HTML_FIXTURE,
      }),
    );
    expectEscapedInterpolation(
      renderFieldList(html, "outbound", "o", {
        summary: FIELD_HTML_FIXTURE,
        actionId: FIELD_HTML_FIXTURE,
      }),
    );
  });

  it("keeps a real SwiftUI iOS field target in tree on the same API", async () => {
    const root = path.join(REPO_ROOT, "clients/field-ios");
    const pbx = await readFile(path.join(root, "Field.xcodeproj/project.pbxproj"), "utf8");
    expect(pbx).toMatch(/PBXNativeTarget/);
    expect(pbx).toMatch(/com\.apple\.product-type\.application/);
    expect(pbx).toMatch(/llc\.alphavector\.dev/);
    expect(pbx).toMatch(/FieldApp\.swift in Sources/);
    expect(pbx).toMatch(/HomeView\.swift in Sources/);

    const app = await readFile(path.join(root, "Field/FieldApp.swift"), "utf8");
    expect(app).toMatch(/import SwiftUI/);
    expect(app).toMatch(/@main/);

    const api = await readFile(path.join(root, "Field/FieldAPI.swift"), "utf8");
    expect(api).toMatch(/\/field\/home/);
    expect(api).toMatch(/\/field\/journeys/);
    expect(api).toMatch(/\/field\/cards/);
    expect(api).toMatch(/\/field\/ask/);
    expect(api).toMatch(/\/field\/continue/);
    expect(api).toMatch(/func continueRun\(\)/);
    expect(api).toMatch(/\/field\/facts/);
    expect(api).toMatch(/\/field\/facts\/retract/);
    expect(api).toMatch(/\/field\/records/);
    expect(api).toMatch(/\/field\/records\/update/);
    expect(api).toMatch(/\/field\/records\/attributes\/retract/);
    expect(api).toMatch(/\/field\/records\/retract/);
    expect(api).toMatch(/func start\(journeyKind: String, objective: String, recordId: String\)/);
    expect(api).toMatch(/"recordId": recordId/);
    expect(api).toMatch(/func open\(kindId: String, recordId: String\)/);
    expect(api).toMatch(/func record\(id: String, recordId: String\)/);
    expect(api).toMatch(/func retract\(id: String, recordId: String\)/);
    expect(api).toMatch(/func create\(type: String, label: String\)/);
    expect(api).toMatch(/func retractAttribute\(recordId: String, key: String\)/);
    expect(api).toMatch(/func retractRecord\(recordId: String\)/);
    expect(api).toMatch(/"journey\.\\\(kindId\)"/);
    expect(api).not.toMatch(/func start\(journeyKind: String, objective: String\) async/);
    expect(api).not.toMatch(/journey\.buyer/);
    expect(api).not.toMatch(/purpose\.follow-up|consent\.dnc/);
    expect(api).not.toMatch(/Desk|Shape|Director|Play|Plant|HIL|Thor|Mission Control|T0|T1|T2|T3/);
    expect(api).not.toMatch(/OAuth|SSO|MLS/);
    expect(api).not.toMatch(/api\.openai\.com|api\.anthropic\.com|anthropic\.com|openai\.azure\.com/);
    expect(api).not.toMatch(/architectControls|\/architect\/habitat|ArchitectHabitat/i);

    const models = await readFile(path.join(root, "Field/Models.swift"), "utf8");
    expect(models).toMatch(/purposeFacts/);
    expect(models).toMatch(/avoidFacts/);
    expect(models).toMatch(/recordKinds/);
    expect(models).toMatch(/var records/);
    expect(models).toMatch(/struct FieldRecordRow/);
    expect(models).toMatch(/struct FieldFactResult/);
    expect(models).toMatch(/var recordId: String\?/);
    expect(models).not.toMatch(/architectControls|\/architect\/habitat|ArchitectHabitat/i);
    expect(models).not.toMatch(/listing_id|person_id|household_id|buyer_id/i);
    expect(models).not.toMatch(/api\.openai\.com|api\.anthropic\.com/);

    const home = await readFile(path.join(root, "Field/HomeView.swift"), "utf8");
    expect(home).toMatch(/import SwiftUI/);
    expect(home).toMatch(/Start journey/);
    expect(home).toMatch(/approve/);
    expect(home).toMatch(/Issued field token/);
    expect(home).toMatch(/Button\("Open"\)/);
    expect(home).toMatch(/Create record/);
    expect(home).toMatch(/Retract record/);
    expect(home).toMatch(/Set attribute/);
    expect(home).toMatch(/Select a record before starting/);
    expect(home).toMatch(/Select a record before opening/);
    expect(home).toMatch(/Select a record before recording a purpose/);
    expect(home).toMatch(/Select a record before recording an avoid/);
    expect(home).toMatch(/Select a record before retracting an avoid/);
    expect(home).toMatch(/Select a record before recording a fact/);
    expect(home).toMatch(/Select a record before retracting a fact/);
    expect(home).toMatch(/Select a record before requesting follow-up/);
    expect(home).toMatch(/Select a record before setting an attribute/);
    expect(home).toMatch(/Select a record before retracting an attribute/);
    expect(home).toMatch(/Select a record before retracting a record/);
    expect(home).toMatch(/api\.start\(journeyKind: kind, objective: objective, recordId:/);
    expect(home).toMatch(/api\.open\(/);
    expect(home).toMatch(/api\.create\(/);
    expect(home).toMatch(/api\.update\(/);
    expect(home).toMatch(/api\.retractAttribute\(/);
    expect(home).toMatch(/api\.retractRecord\(/);
    expect(home).toMatch(/api\.record\(/);
    expect(home).toMatch(/api\.retract\(/);
    expect(home).toMatch(/subject: recordId/);
    expect(home).not.toMatch(/api\.start\(journeyKind: kind, objective: objective\)\s*$/m);
    expect(home).not.toContain("Work this buyer journey");
    expect(home).not.toMatch(/id: "buyer"/);
    expect(home).not.toMatch(/journey\.buyer/);
    expect(home).not.toMatch(/purpose\.follow-up|consent\.dnc/);
    expect(home).not.toMatch(/listing_id|person_id|household_id|buyer_id/i);
    expect(home).not.toMatch(/architectControls|pick a model|edit prompt|inspect temporal|configure tool/i);
    expect(home).not.toMatch(/Theos|UIKit|SwiftPM|Package\.swift/);
    expect(home).not.toMatch(/api\.openai\.com|api\.anthropic\.com/);
  });

  it("denies missing and bad tokens on fact write and keeps Architect off the path", async () => {
    const { url, tenantId, field, architect } = await liveField("fact-auth");
    const body = JSON.stringify({ id: REQUIRED });
    for (const headers of [
      {},
      { authorization: "Bearer " },
      { authorization: "Bearer field-dev-token" },
      { authorization: `Bearer field-${tenantId}` },
      { authorization: "Bearer not-issued" },
    ]) {
      const res = await fetch(`${url}/field/facts`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
      expect(res.status).toBe(401);
      const denied = (await res.json()) as { error: string };
      expect(denied.error).toBe("UNAUTHORIZED");
    }
    await expect(architect.record(REQUIRED, "rec_none")).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
      message: expect.stringMatching(/field user/),
    });
    const rec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Subject",
    );
    const cardId = await issueFactCard(field, REQUIRED, rec.id);
    expect(cardId).toMatch(/^card_/);
  });

  it("persists a fact only after approve and lets REQUIRES pass then fail after retract", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-http-"));
    const { field, tenantId } = await liveMutatedField("fact-write", dir, (unsigned) => {
      const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
      if (buyer) buyer.REQUIRES = [REQUIRED];
    });
    const paths = computerRoot(dir, tenantId);

    const rec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Subject",
    );
    await expect(field.start("buyer", "Work this buyer journey", rec.id)).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing/),
    });

    const cardId = await field.requestFactCard(REQUIRED, "record", rec.id);
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual([]);
    await expect(field.start("buyer", "Work this buyer journey", rec.id)).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
    });

    const approved = await field.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.fact).toEqual({ id: REQUIRED, present: true, recordId: rec.id });
    expect(paths.factsFile).toBe(path.join(dir, "tenants", tenantId, "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8"))).toEqual({
      facts: [{ id: REQUIRED, recordId: rec.id }],
    });
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual([REQUIRED]);

    const journey = await field.start("buyer", "Work this buyer journey", rec.id);
    expect(journey.journeyKind).toBe("buyer");
    expect(journey.status).toBe("open");

    const retractId = await field.requestFactCard(REQUIRED, "retract", rec.id);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual([REQUIRED]);
    const retracted = await field.approve(retractId);
    expect(retracted.fact).toEqual({ id: REQUIRED, present: false, recordId: rec.id });
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual([]);
    await expect(field.start("buyer", "Work this buyer journey", rec.id)).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/fail closed/),
    });
  });

  it("keeps a denied HTTP fact write off disk and terminal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-http-deny-"));
    const { field, tenantId } = await liveMutatedField("fact-deny", dir, () => undefined);
    const paths = computerRoot(dir, tenantId);
    const rec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Subject",
    );
    const cardId = await issueFactCard(field, REQUIRED, rec.id);
    const denied = await field.deny(cardId);
    expect(denied.status).toBe("denied");
    expect(existsSync(paths.factsFile)).toBe(false);
    await expect(field.record(REQUIRED, rec.id)).rejects.toMatchObject({
      status: 403,
      code: "DENY_IS_TERMINAL",
    });
    expect(existsSync(paths.factsFile)).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
  });

  it("authored pin fail-closes buyer start until journey.buyer is approved on disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-authored-http-"));
    const { field, tenantId } = await liveField("authored", dir);
    const paths = computerRoot(dir, tenantId);

    const emptyRec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Empty subject",
    );
    await expect(field.start("buyer", "Work this buyer journey", emptyRec.id)).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing/),
    });

    const buyerRec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Buyer subject",
    );
    const recorded = await field.openApproved("buyer", buyerRec.id);
    expect(recorded).toEqual({ id: "journey.buyer", present: true, recordId: buyerRec.id });
    expect(paths.factsFile).toBe(path.join(dir, "tenants", tenantId, "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, buyerRec.id)).toEqual(["journey.buyer"]);

    const journey = await field.start("buyer", "Work this buyer journey", buyerRec.id);
    expect(journey.journeyKind).toBe("buyer");
    expect(journey.recordId).toBe(buyerRec.id);

    await field.kill("one goal");

    const sellerRec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Seller subject",
    );
    await field.openApproved("seller", sellerRec.id);
    const seller = await field.start("seller", "Work this seller journey", sellerRec.id);
    expect(seller.journeyKind).toBe("seller");

    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: buyerRec.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing/),
    });
    await field.recordApprovedFact("purpose.follow-up", buyerRec.id);
    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: buyerRec.id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "AUTHORIZATION_REQUIRED",
    });

    await field.recordApprovedFact("consent.dnc", buyerRec.id);
    await expect(field.start("buyer", "DNC must fail closed", buyerRec.id)).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/AVOIDS present/),
    });
  });

  it("opens a pack journey kind through the fact card path without starting it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-open-kind-"));
    const { field, architect, tenantId, pack } = await liveField("open-kind", dir);
    const paths = computerRoot(dir, tenantId);
    const kind = pack.binding.journeyKinds[0];
    expect(kind?.id).toBe("buyer");

    const rec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Subject",
    );
    await expect(field.start(kind.id, `Work this ${kind.label} journey`, rec.id)).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing|fail closed/),
    });

    const cardId = await field.open(kind.id, rec.id);
    expect(cardId).toMatch(/^card_/);
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual([]);

    const approved = await field.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.fact).toEqual({
      id: field.journeyFactId(kind.id),
      present: true,
      recordId: rec.id,
    });
    expect(paths.factsFile).toBe(path.join(dir, "tenants", tenantId, "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(["journey.buyer"]);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).not.toContain("purpose.follow-up");

    const journey = await field.start(kind.id, `Work this ${kind.label} journey`, rec.id);
    expect(journey.journeyKind).toBe(kind.id);
    expect(journey.status).toBe("open");
    expect(journey.recordId).toBe(rec.id);

    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: rec.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing/),
    });
    const purposeHome = await field.home();
    const purpose = field.communicateRequiresPurpose(purposeHome);
    expect(purpose.id).toMatch(/^purpose\./);
    expect(purposeHome.purposeFacts.map((f) => f.id)).toContain(purpose.id);
    await field.recordApprovedFact(purpose.id, rec.id);
    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: rec.id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "AUTHORIZATION_REQUIRED",
    });

    await expect(architect.open(kind.id, rec.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
  });

  it("records a pack purpose fact from home and unblocks communicate after approve", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-purpose-list-"));
    const { field, architect, tenantId, pack, world } = await liveFieldWithWorld("purpose-list", dir);
    const paths = computerRoot(dir, tenantId);
    const kind = pack.binding.journeyKinds[0];
    const home = await field.home();
    expect(home.purposeFacts).toEqual(
      pack.binding.actionClassVerbs
        .flatMap((v) => [...(v.REQUIRES ?? []), ...(v.PREFERS ?? [])])
        .concat(pack.binding.journeyKinds.flatMap((k) => [...(k.REQUIRES ?? []), ...(k.PREFERS ?? [])]))
        .filter((id, i, all) => id.startsWith("purpose.") && all.indexOf(id) === i)
        .map((id) => ({ id, label: pack.binding.fieldLanguageMap[id] ?? id })),
    );
    expect(home.purposeFacts.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "purpose.follow-up",
        "purpose.showing",
        "purpose.listing",
        "purpose.transaction",
      ]),
    );
    expect(home.purposeFacts.every((f) => f.id.startsWith("purpose."))).toBe(true);
    expect(home.purposeFacts.map((f) => f.id).join(" ")).not.toMatch(/consent\./);
    expect(JSON.stringify(home)).not.toMatch(/listing_id|person_id|household_id|buyer_id/i);
    expect(JSON.stringify(home)).not.toMatch(/Desk|Shape|Director|Play|Plant|HIL|Thor/);

    const rec = await field.createApprovedRecord(home.recordKinds[0]?.id ?? "record", "Subject");
    await field.openApproved(kind.id, rec.id);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(["journey.buyer"]);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).not.toContain("purpose.follow-up");

    const journey = await field.start(kind.id, `Work this ${kind.label} journey`, rec.id);
    const purpose = field.communicateRequiresPurpose(home);
    expect(pack.binding.actionClassVerbs.find((v) => v.id === "communicate")?.REQUIRES).toContain(
      purpose.id,
    );

    const cardId = await field.requestFactCard(purpose.id, "record", rec.id);
    expect(cardId).toMatch(/^card_/);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(["journey.buyer"]);
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8")).facts).toEqual([
      { id: "journey.buyer", recordId: rec.id },
    ]);

    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: rec.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing/),
    });

    const approved = await field.approve(cardId);
    expect(approved.fact).toEqual({ id: purpose.id, present: true, recordId: rec.id });
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(
      expect.arrayContaining(["journey.buyer", purpose.id]),
    );

    try {
      await field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: rec.id,
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "AUTHORIZATION_REQUIRED" });
      if (!(err instanceof FieldHttpError) || !err.cardId) throw err;
      const executed = await field.approve(err.cardId);
      expect(executed.effect?.executed).toBe(true);
      expect(world.requests).toHaveLength(1);
      expect(world.requests[0]?.method).toBe("POST");
    }

    await expect(architect.record(purpose.id, rec.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    await expect(
      architect.start(kind.id, `Work this ${kind.label} journey`, rec.id),
    ).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
  });

  it("records a pack AVOIDS fact from home and fail-closes communicate after approve", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-avoid-list-"));
    const { field, architect, tenantId, pack } = await liveFieldWithWorld("avoid-list", dir);
    const paths = computerRoot(dir, tenantId);
    const kind = pack.binding.journeyKinds[0];
    const home = await field.home();
    expect(home.avoidFacts).toEqual(
      pack.binding.actionClassVerbs
        .flatMap((v) => v.AVOIDS ?? [])
        .concat(pack.binding.journeyKinds.flatMap((k) => k.AVOIDS ?? []))
        .filter((id, i, all) => id && all.indexOf(id) === i)
        .map((id) => ({ id, label: pack.binding.fieldLanguageMap[id] ?? id })),
    );
    expect(home.avoidFacts.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "consent.dnc",
        "consent.quiet-hours",
        "consent.assumed-autonomy",
        "consent.crm-update",
        "consent.recovery",
        "consent.scheduling",
      ]),
    );
    expect(home.avoidFacts.map((f) => f.id).join(" ")).not.toMatch(/purpose\./);
    expect(home.purposeFacts.map((f) => f.id).join(" ")).not.toMatch(/consent\./);
    expect(JSON.stringify(home)).not.toMatch(/listing_id|person_id|household_id|buyer_id/i);
    expect(JSON.stringify(home)).not.toMatch(/Desk|Shape|Director|Play|Plant|HIL|Thor/);

    const avoided = communicateAvoidFromHome(home, pack);
    expect(pack.binding.actionClassVerbs.find((v) => v.id === "communicate")?.AVOIDS).toContain(
      avoided.id,
    );
    expect(avoided.id).toBe("consent.dnc");

    const rec = await field.createApprovedRecord(home.recordKinds[0]?.id ?? "record", "Subject");
    await field.openApproved(kind.id, rec.id);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(["journey.buyer"]);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).not.toContain(avoided.id);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).not.toContain("purpose.follow-up");

    const avoidCardId = await field.requestFactCard(avoided.id, "record", rec.id);
    expect(avoidCardId).toMatch(/^card_/);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(["journey.buyer"]);
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8")).facts).toEqual([
      { id: "journey.buyer", recordId: rec.id },
    ]);

    const recordedAvoid = await field.approve(avoidCardId);
    expect(recordedAvoid.fact).toEqual({ id: avoided.id, present: true, recordId: rec.id });
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(
      expect.arrayContaining(["journey.buyer", avoided.id]),
    );
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).not.toContain("purpose.follow-up");

    const retractId = await field.requestFactCard(avoided.id, "retract", rec.id);
    const retracted = await field.approve(retractId);
    expect(retracted.fact).toEqual({ id: avoided.id, present: false, recordId: rec.id });
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(["journey.buyer"]);

    const purpose = field.communicateRequiresPurpose(home);
    await field.recordApprovedFact(purpose.id, rec.id);
    const journey = await field.start(kind.id, `Work this ${kind.label} journey`, rec.id);

    try {
      await field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: rec.id,
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "AUTHORIZATION_REQUIRED" });
    }
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).not.toContain(avoided.id);

    const unapprovedAvoid = await field.requestFactCard(avoided.id, "record", rec.id);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).not.toContain(avoided.id);
    try {
      await field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: rec.id,
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "AUTHORIZATION_REQUIRED" });
    }

    const approvedAvoid = await field.approve(unapprovedAvoid);
    expect(approvedAvoid.fact).toEqual({ id: avoided.id, present: true, recordId: rec.id });
    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: rec.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/AVOIDS present/),
    });

    const restoreId = await field.requestFactCard(avoided.id, "retract", rec.id);
    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: rec.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/AVOIDS present/),
    });
    const restored = await field.approve(restoreId);
    expect(restored.fact).toEqual({ id: avoided.id, present: false, recordId: rec.id });
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(
      expect.arrayContaining(["journey.buyer", purpose.id]),
    );
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).not.toContain(avoided.id);

    try {
      await field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: rec.id,
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "AUTHORIZATION_REQUIRED" });
      if (!(err instanceof FieldHttpError) || !err.cardId) throw err;
      const executed = await field.approve(err.cardId);
      expect(executed.effect?.executed).toBe(true);
    }

    await expect(architect.record(avoided.id, rec.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    await expect(architect.retract(avoided.id, rec.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    await expect(
      architect.start(kind.id, `Work this ${kind.label} journey`, rec.id),
    ).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
  });

  it("creates records through the card path and scopes DNC to the subject", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-records-http-subject-"));
    const { field, architect, tenantId, pack, url } = await liveFieldWithWorld("records-subject", dir);
    const paths = computerRoot(dir, tenantId);
    const home = await field.home();
    const kind = pack.binding.journeyKinds[0];
    const type = home.recordKinds[0];
    expect(type?.id).toBeTruthy();
    expect(type?.id).not.toMatch(/listing_id|person_id|household_id|buyer_id/i);
    const avoided = communicateAvoidFromHome(home, pack);
    const purpose = field.communicateRequiresPurpose(home);

    await expect(architect.create(type.id, "A")).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    const unauthed = await fetch(`${url}/field/records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: type.id, label: "A" }),
    });
    expect(unauthed.status).toBe(401);

    const unapproved = await field.requestRecordCard(type.id, "A");
    expect(unapproved).toMatch(/^card_/);
    expect(existsSync(paths.recordsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "records.json"))).toBe(false);
    expect((await field.home()).records).toEqual([]);

    const createdA = await field.approve(unapproved);
    expect(createdA.record).toMatchObject({ type: type.id, label: "A" });
    expect(createdA.record?.id).toMatch(/^rec_/);
    expect(paths.recordsFile).toBe(path.join(dir, "tenants", tenantId, "records.json"));
    expect(existsSync(paths.recordsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "records.json"))).toBe(false);
    expect(JSON.parse(readFileSync(paths.recordsFile, "utf8")).records).toEqual([
      { id: createdA.record!.id, type: type.id, label: "A", attributes: {} },
    ]);

    const recA = createdA.record!;
    const recB = await field.createApprovedRecord(type.id, "B");
    expect(recB.id).not.toBe(recA.id);
    expect((await field.home()).records.map((r) => r.id).sort()).toEqual(
      [recA.id, recB.id].sort(),
    );

    await field.openApproved(kind.id, recB.id);
    await field.recordApprovedFact(purpose.id, recA.id);
    await field.recordApprovedFact(avoided.id, recA.id);
    await field.recordApprovedFact(purpose.id, recB.id);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, recA.id)).toEqual(
      expect.arrayContaining([purpose.id, avoided.id]),
    );
    expect(new FactBook(dir).presentIds(tenantId, recA.id)).not.toContain("journey.buyer");
    expect(new FactBook(dir).presentIds(tenantId, recB.id)).toEqual(
      expect.arrayContaining(["journey.buyer", purpose.id]),
    );
    expect(new FactBook(dir).presentIds(tenantId, recB.id)).not.toContain(avoided.id);

    const journey = await field.start(kind.id, `Work this ${kind.label} journey`, recB.id);
    expect(journey.recordId).toBe(recB.id);
    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: recA.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/AVOIDS present/),
    });

    try {
      await field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: recB.id,
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "AUTHORIZATION_REQUIRED" });
      if (!(err instanceof FieldHttpError) || !err.cardId) throw err;
      const executed = await field.approve(err.cardId);
      expect(executed.effect?.executed).toBe(true);
    }

    await expect(architect.record(purpose.id, recA.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    await expect(
      architect.start(kind.id, `Work this ${kind.label} journey`, recA.id),
    ).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
  });

  it("opens a journey on A and does not satisfy start about B", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-journey-subject-scope-"));
    const { field, architect, tenantId, pack } = await liveField("open-a-start-b", dir);
    const paths = computerRoot(dir, tenantId);
    const kind = pack.binding.journeyKinds[0];
    const type = (await field.home()).recordKinds[0];
    const recA = await field.createApprovedRecord(type.id, "A");
    const recB = await field.createApprovedRecord(type.id, "B");

    const unapproved = await field.open(kind.id, recA.id);
    expect(unapproved).toMatch(/^card_/);
    expect(existsSync(paths.factsFile)).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, recA.id)).toEqual([]);
    expect(new FactBook(dir).presentIds(tenantId, recB.id)).toEqual([]);

    const opened = await field.approve(unapproved);
    expect(opened.fact).toEqual({
      id: field.journeyFactId(kind.id),
      present: true,
      recordId: recA.id,
    });
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8")).facts).toEqual([
      { id: "journey.buyer", recordId: recA.id },
    ]);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, recA.id)).toEqual(["journey.buyer"]);
    expect(new FactBook(dir).presentIds(tenantId, recB.id)).toEqual([]);

    const startedA = await field.start(kind.id, `Work this ${kind.label} journey`, recA.id);
    expect(startedA.journeyKind).toBe(kind.id);
    expect(startedA.status).toBe("open");
    expect(startedA.recordId).toBe(recA.id);

    await expect(
      field.start(kind.id, `Work this ${kind.label} journey`, recB.id),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing/),
    });

    await expect(architect.open(kind.id, recA.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    await expect(
      architect.start(kind.id, `Work this ${kind.label} journey`, recA.id),
    ).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
  });

  it("denies start and Open with no recordId or unknown recordId", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-http-record-required-"));
    const { field, url, tokens, tenantId, pack } = await liveField("record-required", dir);
    const kind = pack.binding.journeyKinds[0];
    const rec = await field.createApprovedRecord(
      (await field.home()).recordKinds[0]?.id ?? "record",
      "Subject",
    );
    await field.openApproved(kind.id, rec.id);

    const startMissing = await fetch(`${url}/field/journeys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.field}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ journeyKind: kind.id, objective: `Work this ${kind.label} journey` }),
    });
    expect(startMissing.status).toBe(400);
    expect(await startMissing.json()).toMatchObject({ error: "RECORD_ID_REQUIRED" });

    await expect(
      field.start(kind.id, `Work this ${kind.label} journey`, "rec_unknown"),
    ).rejects.toMatchObject({
      status: 404,
      code: "RECORD_NOT_FOUND",
    });

    const openMissing = await fetch(`${url}/field/facts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.field}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: field.journeyFactId(kind.id) }),
    });
    expect(openMissing.status).toBe(400);
    expect(await openMissing.json()).toMatchObject({ error: "RECORD_ID_REQUIRED" });
    expect(existsSync(computerRoot(dir, tenantId).factsFile)).toBe(true);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);

    await expect(field.open(kind.id, "rec_unknown")).rejects.toMatchObject({
      status: 404,
      code: "RECORD_NOT_FOUND",
    });

    const startedA = await field.start(kind.id, `Work this ${kind.label} journey`, rec.id);
    expect(startedA.status).toBe("open");
    expect(startedA.recordId).toBe(rec.id);
  });

  it("denies purpose, AVOIDS, and generic fact writes with no recordId or unknown recordId", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-http-fact-record-required-"));
    const { field, url, tokens, tenantId, pack } = await liveField("fact-record-required", dir);
    const home = await field.home();
    const purpose = field.communicateRequiresPurpose(home);
    const avoided = communicateAvoidFromHome(home, pack);
    const rec = await field.createApprovedRecord(home.recordKinds[0]?.id ?? "record", "Subject");
    const ids = [purpose.id, avoided.id, REQUIRED];

    for (const id of ids) {
      for (const path of ["/field/facts", "/field/facts/retract"]) {
        const missing = await fetch(`${url}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokens.field}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id }),
        });
        expect(missing.status).toBe(400);
        expect(await missing.json()).toMatchObject({ error: "RECORD_ID_REQUIRED" });

        const unknown = await fetch(`${url}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokens.field}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id, recordId: "rec_unknown" }),
        });
        expect(unknown.status).toBe(404);
        expect(await unknown.json()).toMatchObject({ error: "RECORD_NOT_FOUND" });
      }
      expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
      expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual([]);
    }

    const cardId = await field.requestFactCard(REQUIRED, "record", rec.id);
    expect(cardId).toMatch(/^card_/);
    expect(existsSync(computerRoot(dir, tenantId).factsFile)).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual([]);
  });

  it("denies action progress with no subject or unknown subject", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-http-action-subject-required-"));
    const { field, url, tokens, tenantId, pack } = await liveField("action-subject-required", dir);
    const kind = pack.binding.journeyKinds[0];
    const home = await field.home();
    const purpose = field.communicateRequiresPurpose(home);
    const rec = await field.createApprovedRecord(home.recordKinds[0]?.id ?? "record", "Subject");
    await field.openApproved(kind.id, rec.id);
    await field.recordApprovedFact(purpose.id, rec.id);
    const journey = await field.start(kind.id, `Work this ${kind.label} journey`, rec.id);
    const body = {
      actionClass: "communicate",
      channel: "email",
      purpose: purpose.id.slice("purpose.".length),
    };

    const missing = await fetch(`${url}/field/journeys/${journey.id}/progress`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.field}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "RECORD_ID_REQUIRED" });

    await expect(
      field.progress(journey.id, { ...body, subject: "buyer" }),
    ).rejects.toMatchObject({
      status: 404,
      code: "RECORD_NOT_FOUND",
    });
    await expect(
      field.progress(journey.id, { ...body, subject: "rec_unknown" }),
    ).rejects.toMatchObject({
      status: 404,
      code: "RECORD_NOT_FOUND",
    });

    await expect(field.progress(journey.id, { ...body, subject: rec.id })).rejects.toMatchObject({
      status: 409,
      code: "AUTHORIZATION_REQUIRED",
    });
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(
      expect.arrayContaining([field.journeyFactId(kind.id), purpose.id]),
    );
  });

  it("updates record attributes only after approve and survives RecordBook restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-records-http-attrs-"));
    const { field, architect, tenantId, url, tokens, pack } = await liveField("records-attrs", dir);
    const paths = computerRoot(dir, tenantId);
    const type = (await field.home()).recordKinds[0];
    const rec = await field.createApprovedRecord(type.id, "A");
    expect(rec.attributes).toEqual({});
    expect(JSON.parse(readFileSync(paths.recordsFile, "utf8")).records[0].attributes).toEqual({});

    await expect(architect.update(rec.id, { attributes: { note: "x" } })).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    const unauthed = await fetch(`${url}/field/records/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordId: rec.id, attributes: { note: "x" } }),
    });
    expect(unauthed.status).toBe(401);

    const missing = await fetch(`${url}/field/records/update`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.field}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ attributes: { note: "x" } }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "RECORD_ID_REQUIRED" });

    await expect(field.update("rec_unknown", { attributes: { note: "x" } })).rejects.toMatchObject({
      status: 404,
      code: "RECORD_NOT_FOUND",
    });

    const unapproved = await field.requestRecordUpdateCard(rec.id, { attributes: { note: "hello" } });
    expect(unapproved).toMatch(/^card_/);
    expect(new RecordBook(dir).get(tenantId, rec.id)?.attributes).toEqual({});
    expect(JSON.parse(readFileSync(paths.recordsFile, "utf8")).records[0].attributes).toEqual({});

    const denied = await field.requestRecordUpdateCard(rec.id, { attributes: { other: "no" } });
    await field.deny(denied);
    expect(new RecordBook(dir).get(tenantId, rec.id)?.attributes).toEqual({});

    const approved = await field.approve(unapproved);
    expect(approved.record).toMatchObject({
      id: rec.id,
      type: type.id,
      label: "A",
      attributes: { note: "hello" },
    });
    expect(new RecordBook(dir).get(tenantId, rec.id)).toEqual({
      id: rec.id,
      type: type.id,
      label: "A",
      attributes: { note: "hello" },
    });
    expect(existsSync(path.join(paths.disk, "records.json"))).toBe(false);

    const renamed = await field.updateApprovedRecord(rec.id, { label: "Renamed" });
    expect(renamed.label).toBe("Renamed");
    expect(renamed.attributes).toEqual({ note: "hello" });
    expect(new RecordBook(dir).get(tenantId, rec.id)?.label).toBe("Renamed");

    const home = await field.home();
    const listed = home.records.find((r) => r.id === rec.id);
    expect(listed?.attributes).toEqual({ note: "hello" });
    expect(listed?.label).toBe("Renamed");

    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual([]);
    expect(pack.binding.recordPartyKnowledge.recordKinds[0]).not.toMatch(
      /listing_id|person_id|household_id|buyer_id/i,
    );
  });

  it("retracts a record attribute key only after approve and survives RecordBook restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-records-http-attr-retract-"));
    const { field, architect, tenantId, url, tokens } = await liveField("records-attr-retract", dir);
    const paths = computerRoot(dir, tenantId);
    const type = (await field.home()).recordKinds[0];
    const rec = await field.createApprovedRecord(type.id, "A");
    const set = await field.updateApprovedRecord(rec.id, { attributes: { note: "hello", keep: "yes" } });
    expect(set.attributes).toEqual({ note: "hello", keep: "yes" });

    await expect(architect.retractAttribute(rec.id, "note")).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    const unauthed = await fetch(`${url}/field/records/attributes/retract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordId: rec.id, key: "note" }),
    });
    expect(unauthed.status).toBe(401);

    const missingRecord = await fetch(`${url}/field/records/attributes/retract`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.field}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ key: "note" }),
    });
    expect(missingRecord.status).toBe(400);
    expect(await missingRecord.json()).toMatchObject({ error: "RECORD_ID_REQUIRED" });

    const missingKey = await fetch(`${url}/field/records/attributes/retract`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.field}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ recordId: rec.id }),
    });
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ error: "RECORD_ATTRIBUTE_KEY_REQUIRED" });

    await expect(field.retractAttribute("rec_unknown", "note")).rejects.toMatchObject({
      status: 404,
      code: "RECORD_NOT_FOUND",
    });
    await expect(field.retractAttribute(rec.id, "missing")).rejects.toMatchObject({
      status: 404,
      code: "RECORD_ATTRIBUTE_NOT_FOUND",
    });

    const unapproved = await field.requestRecordAttributeRetractCard(rec.id, "note");
    expect(unapproved).toMatch(/^card_/);
    expect(new RecordBook(dir).get(tenantId, rec.id)?.attributes).toEqual({
      note: "hello",
      keep: "yes",
    });
    expect(JSON.parse(readFileSync(paths.recordsFile, "utf8")).records[0].attributes).toEqual({
      note: "hello",
      keep: "yes",
    });

    const denied = await field.requestRecordAttributeRetractCard(rec.id, "keep");
    await field.deny(denied);
    expect(new RecordBook(dir).get(tenantId, rec.id)?.attributes).toEqual({
      note: "hello",
      keep: "yes",
    });
    await expect(field.retractAttribute(rec.id, "keep")).rejects.toMatchObject({
      status: 403,
      code: "DENY_IS_TERMINAL",
    });

    const approved = await field.approve(unapproved);
    expect(approved.record).toMatchObject({
      id: rec.id,
      type: type.id,
      label: "A",
      attributes: { keep: "yes" },
    });
    expect(new RecordBook(dir).get(tenantId, rec.id)?.attributes).toEqual({ keep: "yes" });
    expect(existsSync(path.join(paths.disk, "records.json"))).toBe(false);

    const restarted = new RecordBook(dir).get(tenantId, rec.id);
    expect(restarted?.attributes).toEqual({ keep: "yes" });
    const home = await field.home();
    expect(home.records.find((r) => r.id === rec.id)?.attributes).toEqual({ keep: "yes" });
  });

  it("retracts a whole record only after approve and survives RecordBook restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-records-http-retract-"));
    const { field, architect, tenantId, url, tokens } = await liveField("records-retract", dir);
    const paths = computerRoot(dir, tenantId);
    const type = (await field.home()).recordKinds[0];
    const keep = await field.createApprovedRecord(type.id, "Keep");
    const rec = await field.createApprovedRecord(type.id, "Gone");
    await field.recordApprovedFact("journey.buyer", rec.id);
    await field.recordApprovedFact("purpose.follow-up", rec.id);
    await field.recordApprovedFact("journey.seller", keep.id);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(
      expect.arrayContaining(["journey.buyer", "purpose.follow-up"]),
    );
    expect(new FactBook(dir).presentIds(tenantId, keep.id)).toEqual(["journey.seller"]);
    expect(paths.factsFile).toBe(path.join(dir, "tenants", tenantId, "facts.json"));
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);

    await expect(architect.retractRecord(rec.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    const unauthed = await fetch(`${url}/field/records/retract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordId: rec.id }),
    });
    expect(unauthed.status).toBe(401);

    const missingRecord = await fetch(`${url}/field/records/retract`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.field}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(missingRecord.status).toBe(400);
    expect(await missingRecord.json()).toMatchObject({ error: "RECORD_ID_REQUIRED" });

    await expect(field.retractRecord("rec_unknown")).rejects.toMatchObject({
      status: 404,
      code: "RECORD_NOT_FOUND",
    });

    const unapproved = await field.requestRecordRetractCard(rec.id);
    expect(unapproved).toMatch(/^card_/);
    expect(new RecordBook(dir).get(tenantId, rec.id)?.label).toBe("Gone");
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(
      expect.arrayContaining(["journey.buyer", "purpose.follow-up"]),
    );
    expect(new FactBook(dir).presentIds(tenantId, keep.id)).toEqual(["journey.seller"]);
    expect(JSON.parse(readFileSync(paths.recordsFile, "utf8")).records.map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining([keep.id, rec.id]),
    );

    const denied = await field.requestRecordRetractCard(keep.id);
    await field.deny(denied);
    expect(new RecordBook(dir).get(tenantId, keep.id)?.label).toBe("Keep");
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual(
      expect.arrayContaining(["journey.buyer", "purpose.follow-up"]),
    );
    expect(new FactBook(dir).presentIds(tenantId, keep.id)).toEqual(["journey.seller"]);
    await expect(field.retractRecord(keep.id)).rejects.toMatchObject({
      status: 403,
      code: "DENY_IS_TERMINAL",
    });

    const approved = await field.approve(unapproved);
    expect(approved.fact).toEqual({ id: rec.id, present: false });
    expect(approved.record).toBeUndefined();
    expect(new RecordBook(dir).get(tenantId, rec.id)).toBeUndefined();
    expect(new RecordBook(dir).get(tenantId, keep.id)?.label).toBe("Keep");
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), tenantId);
    expect(new FactBook(dir).presentIds(tenantId, rec.id)).toEqual([]);
    expect(new FactBook(dir).presentIds(tenantId, keep.id)).toEqual(["journey.seller"]);
    expect(existsSync(path.join(paths.disk, "records.json"))).toBe(false);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(JSON.parse(readFileSync(paths.recordsFile, "utf8")).records).toEqual([
      expect.objectContaining({ id: keep.id, label: "Keep" }),
    ]);
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8")).facts).toEqual([
      { id: "journey.seller", recordId: keep.id },
    ]);

    const restarted = new RecordBook(dir);
    expect(restarted.get(tenantId, rec.id)).toBeUndefined();
    expect(restarted.get(tenantId, keep.id)?.label).toBe("Keep");
    const restartedFacts = new FactBook(dir);
    expectPresentIdsDeniedWithoutRecord(restartedFacts, tenantId);
    expect(restartedFacts.presentIds(tenantId, rec.id)).toEqual([]);
    expect(restartedFacts.presentIds(tenantId, keep.id)).toEqual(["journey.seller"]);
    const home = await field.home();
    expect(home.records.find((r) => r.id === rec.id)).toBeUndefined();
    expect(home.records.find((r) => r.id === keep.id)?.label).toBe("Keep");
  });

  it("keeps RE types out of core schema and migrations", async () => {
    const migrationFiles = await readdir(path.join(REPO_ROOT, "migrations"));
    const migrationSql = (
      await Promise.all(
        migrationFiles
          .filter((name) => name.endsWith(".sql"))
          .map((name) => readFile(path.join(REPO_ROOT, "migrations", name), "utf8")),
      )
    ).join("\n");
    const schemaAndMigrations = `${CORE_SCHEMA_SQL}\n${migrationSql}`;
    expect(schemaAndMigrations).not.toMatch(/listing_id|person_id|household_id|buyer_id/i);
  });
});
