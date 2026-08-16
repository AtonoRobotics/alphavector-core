import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computerRoot } from "../src/computer/paths.js";
import { CORE_SCHEMA_SQL } from "../src/data/sql.js";
import { FactBook } from "../src/facts/book.js";
import { FieldClient, FieldHttpError } from "../src/http/field-client.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { AlphaVectorCore } from "../src/kernel.js";
import type { PackBinding } from "../src/packs/types.js";
import { ALPHAVECTOR_RE_PIN_SHA, REPO_ROOT, signedRePackMutated } from "./helpers.js";

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

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.close();
  }
});

async function liveField(tenantId = "t1", computerBaseDir?: string) {
  const { core, pack } = await bootFieldCore(
    tenantId,
    computerBaseDir ? { computerBaseDir } : {},
  );
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
  };
}

async function liveMutatedField(
  tenantId: string,
  computerBaseDir: string,
  mutate: (unsigned: Omit<PackBinding, "signatures">) => void,
) {
  const { anchors, binding } = await signedRePackMutated(mutate);
  const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir);
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

async function issueFactCard(
  field: FieldClient,
  id: string,
  op: "record" | "retract" = "record",
): Promise<string> {
  return field.requestFactCard(id, op);
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
    await field.openApproved("buyer");
    const journey = await field.start("buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");
    expect(journey.status).toBe("open");
    const home = await field.home();
    expect(home.journeys.map((j) => j.kind)).toContain("buyer");
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
  });

  it("approves an owner card then executes", async () => {
    const { field } = await liveField("approve");
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
    await field.openApproved("buyer");
    const journey = await field.start("buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");
  });

  it("denies a revoked issued token and does not invent a session", async () => {
    const { url, tenantId, fieldIssued, core, field, tokens } = await liveField("revoke");
    await field.openApproved("buyer");
    const journey = await field.start("buyer", "Work this buyer journey");
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
    await expect(field.start("buyer", "Revoked must not start")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("rejects Architect credentials on field start", async () => {
    const { architect, field } = await liveField("authz");
    await expect(architect.start("buyer", "Architect must not use this path")).rejects.toBeInstanceOf(
      FieldHttpError,
    );
    await expect(architect.start("buyer", "Architect must not use this path")).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
      message: expect.stringMatching(/field user/),
    });
    await expect(architect.open("buyer")).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
      message: expect.stringMatching(/field user/),
    });
    await expect(architect.record("journey.buyer")).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    await field.openApproved("buyer");
    const journey = await field.start("buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");
  });

  it("does not expose Architect, models, prompts, Temporal, or tools on field routes", async () => {
    const { url, tokens } = await liveField("closed");
    const headers = { authorization: `Bearer ${tokens.field}` };
    for (const path of ["/field/models", "/field/prompts", "/field/temporal", "/field/tools"]) {
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
    const { url, field, tokens, tenantId, pack } = await liveField("linux", dir);
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
    expect(html).toMatch(/data-open=/);
    expect(html).toMatch(/>Open</);
    expect(html).toMatch(/"journey\." \+ t\.dataset\.open/);
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
    expect(html).toMatch(/home\.recordKinds/);
    expect(html).toMatch(/home\.records/);
    expect(html).toMatch(/data-select-record=/);
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
    expect(html).not.toMatch(/Desk|Shape|Director|Play|Plant|HIL|Thor|Mission Control/);

    const clientSrc = await readFile(path.join(REPO_ROOT, "src/http/field-client.ts"), "utf8");
    expect(clientSrc).not.toMatch(/purpose\.follow-up/);
    expect(clientSrc).not.toMatch(/consent\.dnc/);
    expect(clientSrc).toMatch(/home\.purposeFacts/);
    expect(clientSrc).toMatch(/recordApprovedFact\(purpose\.id/);
    expect(clientSrc).toMatch(/requestFactCard/);
    expect(clientSrc).toMatch(/recordApprovedFact/);
    expect(clientSrc).toMatch(/createApprovedRecord/);
    expect(clientSrc).toMatch(/home\.recordKinds/);
    const fieldSrc = await readFile(path.join(REPO_ROOT, "src/surfaces/field.ts"), "utf8");
    expect(fieldSrc).not.toMatch(/consent\.dnc/);
    expect(fieldSrc).toMatch(/avoidFactsFromBinding/);
    expect(fieldSrc).toMatch(/recordKindsFromBinding/);
    expect(fieldSrc).toMatch(/verb\.AVOIDS/);
    expect(fieldSrc).toMatch(/kind\.AVOIDS/);
    expect(fieldSrc).not.toMatch(/listing_id|person_id|household_id|buyer_id/);

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
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining(["journey.buyer"]),
    );
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain("purpose.follow-up");
    const subject = (await field.home()).records[0];
    expect(subject?.id).toMatch(/^rec_/);
    expect(new FactBook(dir).presentIds(tenantId, subject!.id)).toEqual(["purpose.follow-up"]);
    for (const id of collectAvoidFactIds(pack.binding)) {
      expect(new FactBook(dir).presentIds(tenantId)).not.toContain(id);
      expect(new FactBook(dir).presentIds(tenantId, subject!.id)).not.toContain(id);
    }

    // Same POSTs the page script issues: record/retract then existing card approve.
    const paths = computerRoot(dir, tenantId);
    expect(existsSync(paths.recordsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "records.json"))).toBe(false);
    const recordCardId = await field.requestFactCard(REQUIRED);
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining(["journey.buyer"]),
    );
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain(REQUIRED);
    const recorded = await field.approve(recordCardId);
    expect(recorded.fact).toEqual({ id: REQUIRED, present: true });
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8")).facts).toEqual(
      expect.arrayContaining([
        { id: "journey.buyer" },
        { id: "purpose.follow-up", recordId: subject!.id },
        { id: REQUIRED },
      ]),
    );
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);

    const retractCardId = await field.requestFactCard(REQUIRED, "retract");
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining([REQUIRED, "journey.buyer"]),
    );
    const retracted = await field.approve(retractCardId);
    expect(retracted.fact).toEqual({ id: REQUIRED, present: false });
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining(["journey.buyer"]),
    );
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain(REQUIRED);

    const scripted = await field.completeFactRecordAndRetract("demo.fact");
    expect(scripted.recorded).toEqual({ id: "demo.fact", present: true });
    expect(scripted.retracted).toEqual({ id: "demo.fact", present: false });
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining(["journey.buyer"]),
    );
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain("demo.fact");
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
    expect(api).not.toMatch(/Desk|Shape|Director|Play|Plant|HIL|Thor|Mission Control|T0|T1|T2|T3/);
    expect(api).not.toMatch(/OAuth|SSO|MLS/);

    const home = await readFile(path.join(root, "Field/HomeView.swift"), "utf8");
    expect(home).toMatch(/Start journey/);
    expect(home).toMatch(/approve/);
    expect(home).toMatch(/Issued field token/);
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
    await expect(architect.record(REQUIRED)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
      message: expect.stringMatching(/field user/),
    });
    const cardId = await issueFactCard(field, REQUIRED);
    expect(cardId).toMatch(/^card_/);
  });

  it("persists a fact only after approve and lets REQUIRES pass then fail after retract", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-http-"));
    const { field, tenantId } = await liveMutatedField("fact-write", dir, (unsigned) => {
      const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
      if (buyer) buyer.REQUIRES = [REQUIRED];
    });
    const paths = computerRoot(dir, tenantId);

    await expect(field.start("buyer", "Work this buyer journey")).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing/),
    });

    const cardId = await issueFactCard(field, REQUIRED);
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual([]);
    await expect(field.start("buyer", "Work this buyer journey")).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
    });

    const approved = await field.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.fact).toEqual({ id: REQUIRED, present: true });
    expect(paths.factsFile).toBe(path.join(dir, "tenants", tenantId, "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8"))).toEqual({
      facts: [{ id: REQUIRED }],
    });
    expect(new FactBook(dir).presentIds(tenantId)).toEqual([REQUIRED]);

    const journey = await field.start("buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");
    expect(journey.status).toBe("open");

    const retractId = await issueFactCard(field, REQUIRED, "retract");
    expect(new FactBook(dir).presentIds(tenantId)).toEqual([REQUIRED]);
    const retracted = await field.approve(retractId);
    expect(retracted.fact).toEqual({ id: REQUIRED, present: false });
    expect(new FactBook(dir).presentIds(tenantId)).toEqual([]);
    await expect(field.start("buyer", "Work this buyer journey")).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/fail closed/),
    });
  });

  it("keeps a denied HTTP fact write off disk and terminal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-http-deny-"));
    const { field, tenantId } = await liveMutatedField("fact-deny", dir, () => undefined);
    const paths = computerRoot(dir, tenantId);
    const cardId = await issueFactCard(field, REQUIRED);
    const denied = await field.deny(cardId);
    expect(denied.status).toBe("denied");
    expect(existsSync(paths.factsFile)).toBe(false);
    await expect(field.record(REQUIRED)).rejects.toMatchObject({
      status: 403,
      code: "DENY_IS_TERMINAL",
    });
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual([]);
  });

  it("authored pin fail-closes buyer start until journey.buyer is approved on disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-authored-http-"));
    const { field, tenantId } = await liveField("authored", dir);
    const paths = computerRoot(dir, tenantId);

    await expect(field.start("buyer", "Work this buyer journey")).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing/),
    });

    const recorded = await field.openApproved("buyer");
    expect(recorded).toEqual({ id: "journey.buyer", present: true });
    expect(paths.factsFile).toBe(path.join(dir, "tenants", tenantId, "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(["journey.buyer"]);

    const journey = await field.start("buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");

    await field.openApproved("seller");
    const seller = await field.start("seller", "Work this seller journey");
    expect(seller.journeyKind).toBe("seller");

    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "buyer",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing/),
    });
    await field.recordApprovedFact("purpose.follow-up");
    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "buyer",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "AUTHORIZATION_REQUIRED",
    });

    await field.recordApprovedFact("consent.dnc");
    await expect(field.start("buyer", "DNC must fail closed")).rejects.toMatchObject({
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

    await expect(field.start(kind.id, `Work this ${kind.label} journey`)).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing|fail closed/),
    });

    const cardId = await field.open(kind.id);
    expect(cardId).toMatch(/^card_/);
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual([]);

    const approved = await field.approve(cardId);
    expect(approved.card.status).toBe("approved");
    expect(approved.fact).toEqual({ id: field.journeyFactId(kind.id), present: true });
    expect(paths.factsFile).toBe(path.join(dir, "tenants", tenantId, "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(["journey.buyer"]);
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain("purpose.follow-up");

    const journey = await field.start(kind.id, `Work this ${kind.label} journey`);
    expect(journey.journeyKind).toBe(kind.id);
    expect(journey.status).toBe("open");

    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: kind.id,
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
    await field.recordApprovedFact(purpose.id);
    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: kind.id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "AUTHORIZATION_REQUIRED",
    });

    await expect(architect.open(kind.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
  });

  it("records a pack purpose fact from home and unblocks communicate after approve", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-purpose-list-"));
    const { field, architect, tenantId, pack } = await liveField("purpose-list", dir);
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

    await field.openApproved(kind.id);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(["journey.buyer"]);
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain("purpose.follow-up");

    const journey = await field.start(kind.id, `Work this ${kind.label} journey`);
    const purpose = field.communicateRequiresPurpose(home);
    expect(pack.binding.actionClassVerbs.find((v) => v.id === "communicate")?.REQUIRES).toContain(
      purpose.id,
    );

    const cardId = await field.requestFactCard(purpose.id);
    expect(cardId).toMatch(/^card_/);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(["journey.buyer"]);
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8")).facts).toEqual([{ id: "journey.buyer" }]);

    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: kind.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/REQUIRES missing/),
    });

    const approved = await field.approve(cardId);
    expect(approved.fact).toEqual({ id: purpose.id, present: true });
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining(["journey.buyer", purpose.id]),
    );

    try {
      await field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: kind.id,
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "AUTHORIZATION_REQUIRED" });
      if (!(err instanceof FieldHttpError) || !err.cardId) throw err;
      const executed = await field.approve(err.cardId);
      expect(executed.effect?.executed).toBe(true);
    }

    await expect(architect.record(purpose.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    await expect(architect.start(kind.id, `Work this ${kind.label} journey`)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
  });

  it("records a pack AVOIDS fact from home and fail-closes communicate after approve", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-avoid-list-"));
    const { field, architect, tenantId, pack } = await liveField("avoid-list", dir);
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

    await field.openApproved(kind.id);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(["journey.buyer"]);
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain(avoided.id);
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain("purpose.follow-up");

    const avoidCardId = await field.requestFactCard(avoided.id);
    expect(avoidCardId).toMatch(/^card_/);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(["journey.buyer"]);
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8")).facts).toEqual([{ id: "journey.buyer" }]);

    const recordedAvoid = await field.approve(avoidCardId);
    expect(recordedAvoid.fact).toEqual({ id: avoided.id, present: true });
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining(["journey.buyer", avoided.id]),
    );
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain("purpose.follow-up");

    const retractId = await field.requestFactCard(avoided.id, "retract");
    const retracted = await field.approve(retractId);
    expect(retracted.fact).toEqual({ id: avoided.id, present: false });
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(["journey.buyer"]);

    const purpose = field.communicateRequiresPurpose(home);
    await field.recordApprovedFact(purpose.id);
    const journey = await field.start(kind.id, `Work this ${kind.label} journey`);

    try {
      await field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: kind.id,
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "AUTHORIZATION_REQUIRED" });
    }
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain(avoided.id);

    const unapprovedAvoid = await field.requestFactCard(avoided.id);
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain(avoided.id);
    try {
      await field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: kind.id,
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "AUTHORIZATION_REQUIRED" });
    }

    const approvedAvoid = await field.approve(unapprovedAvoid);
    expect(approvedAvoid.fact).toEqual({ id: avoided.id, present: true });
    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: kind.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/AVOIDS present/),
    });

    const restoreId = await field.requestFactCard(avoided.id, "retract");
    await expect(
      field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: kind.id,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "PREDICATE_CLOSED",
      message: expect.stringMatching(/AVOIDS present/),
    });
    const restored = await field.approve(restoreId);
    expect(restored.fact).toEqual({ id: avoided.id, present: false });
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining(["journey.buyer", purpose.id]),
    );
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain(avoided.id);

    try {
      await field.progress(journey.id, {
        actionClass: "communicate",
        channel: "email",
        purpose: purpose.id.slice("purpose.".length),
        subject: kind.id,
      });
      throw new Error("expected authorization card before execute");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "AUTHORIZATION_REQUIRED" });
      if (!(err instanceof FieldHttpError) || !err.cardId) throw err;
      const executed = await field.approve(err.cardId);
      expect(executed.effect?.executed).toBe(true);
    }

    await expect(architect.record(avoided.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    await expect(architect.retract(avoided.id)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
    await expect(architect.start(kind.id, `Work this ${kind.label} journey`)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
  });

  it("creates records through the card path and scopes DNC to the subject", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-records-http-subject-"));
    const { field, architect, tenantId, pack, url } = await liveField("records-subject", dir);
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
      { id: createdA.record!.id, type: type.id, label: "A" },
    ]);

    const recA = createdA.record!;
    const recB = await field.createApprovedRecord(type.id, "B");
    expect(recB.id).not.toBe(recA.id);
    expect((await field.home()).records.map((r) => r.id).sort()).toEqual(
      [recA.id, recB.id].sort(),
    );

    await field.openApproved(kind.id);
    await field.recordApprovedFact(purpose.id, recA.id);
    await field.recordApprovedFact(avoided.id, recA.id);
    await field.recordApprovedFact(purpose.id, recB.id);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(["journey.buyer"]);
    expect(new FactBook(dir).presentIds(tenantId, recA.id)).toEqual(
      expect.arrayContaining([purpose.id, avoided.id]),
    );
    expect(new FactBook(dir).presentIds(tenantId, recB.id)).toEqual([purpose.id]);
    expect(new FactBook(dir).presentIds(tenantId, recB.id)).not.toContain(avoided.id);
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain(purpose.id);
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain(avoided.id);

    const journey = await field.start(kind.id, `Work this ${kind.label} journey`);
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
    await expect(architect.start(kind.id, `Work this ${kind.label} journey`)).rejects.toMatchObject({
      status: 403,
      code: "SURFACE_VIOLATION",
    });
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
