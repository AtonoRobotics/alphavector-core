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
    await field.recordApprovedFact("journey.buyer");
    const journey = await field.start("buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");
    expect(journey.status).toBe("open");
    const home = await field.home();
    expect(home.journeys.map((j) => j.kind)).toContain("buyer");
    expect(home.architectControls).toEqual([]);
    expect(home.journeyKinds.map((k) => k.id)).toEqual(pack.binding.journeyKinds.map((k) => k.id));
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
    await field.recordApprovedFact("journey.buyer");
    const journey = await field.start("buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");
  });

  it("denies a revoked issued token and does not invent a session", async () => {
    const { url, tenantId, fieldIssued, core, field, tokens } = await liveField("revoke");
    await field.recordApprovedFact("journey.buyer");
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
    await field.recordApprovedFact("journey.buyer");
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
    const { url, field, tokens, tenantId } = await liveField("linux", dir);
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
    expect(html).not.toMatch(/listing_id|person_id|household_id|buyer_id/i);
    expect(html).not.toContain(tokens.field);
    expect(html).not.toMatch(/window\.FIELD_DEFAULTS/);
    expect(html).toMatch(/Issued field token/);
    expect(html).toMatch(/Paste a token Architect issued/);
    expect(html).not.toContain("field-dev-token");
    expect(html).not.toContain(`field-${tenantId}`);
    expect(html).not.toMatch(/architectControls|pick a model|edit prompt|inspect temporal|configure tool/i);
    expect(html).not.toMatch(/Desk|Shape|Director|Play|Plant|HIL|Thor|Mission Control/);

    const done = await field.completeBuyerJourneyAndCard();
    expect(done.journey.journeyKind).toBe("buyer");
    expect(done.effect.executed).toBe(true);

    // Same POSTs the page script issues: record/retract then existing card approve.
    const paths = computerRoot(dir, tenantId);
    const recordCardId = await field.requestFactCard(REQUIRED);
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining(["journey.buyer", "purpose.follow-up"]),
    );
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain(REQUIRED);
    const recorded = await field.approve(recordCardId);
    expect(recorded.fact).toEqual({ id: REQUIRED, present: true });
    expect(JSON.parse(readFileSync(paths.factsFile, "utf8")).facts).toEqual(
      expect.arrayContaining([
        { id: "journey.buyer" },
        { id: "purpose.follow-up" },
        { id: REQUIRED },
      ]),
    );
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);

    const retractCardId = await field.requestFactCard(REQUIRED, "retract");
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining([REQUIRED, "journey.buyer", "purpose.follow-up"]),
    );
    const retracted = await field.approve(retractCardId);
    expect(retracted.fact).toEqual({ id: REQUIRED, present: false });
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining(["journey.buyer", "purpose.follow-up"]),
    );
    expect(new FactBook(dir).presentIds(tenantId)).not.toContain(REQUIRED);

    const scripted = await field.completeFactRecordAndRetract("demo.fact");
    expect(scripted.recorded).toEqual({ id: "demo.fact", present: true });
    expect(scripted.retracted).toEqual({ id: "demo.fact", present: false });
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(
      expect.arrayContaining(["journey.buyer", "purpose.follow-up"]),
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

    const recorded = await field.recordApprovedFact("journey.buyer");
    expect(recorded).toEqual({ id: "journey.buyer", present: true });
    expect(paths.factsFile).toBe(path.join(dir, "tenants", tenantId, "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(new FactBook(dir).presentIds(tenantId)).toEqual(["journey.buyer"]);

    const journey = await field.start("buyer", "Work this buyer journey");
    expect(journey.journeyKind).toBe("buyer");

    await field.recordApprovedFact("journey.seller");
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
