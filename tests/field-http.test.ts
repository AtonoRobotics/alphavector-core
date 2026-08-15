import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FieldClient, FieldHttpError } from "../src/http/field-client.js";
import { bootFieldCore } from "../src/http/field-boot.js";
import { FieldHttpServer } from "../src/http/field-server.js";
import { CORE_SCHEMA_SQL } from "../src/data/sql.js";
import { ALPHAVECTOR_RE_PIN_SHA, REPO_ROOT } from "./helpers.js";

const RE_PIN = "fc7e34e385743c7a6d0adcf9109bf5aa0c5a9230";
const servers: FieldHttpServer[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.close();
  }
});

async function liveField(tenantId = "t1") {
  const { core, pack } = await bootFieldCore(tenantId);
  const tokens = {
    field: `field-${tenantId}`,
    architect: `architect-${tenantId}`,
    counselEval: `counsel-${tenantId}`,
  };
  const server = new FieldHttpServer({ core, pack, tenantId, tokens });
  servers.push(server);
  const { url } = await server.listen(0, "127.0.0.1");
  return {
    url,
    tokens,
    field: new FieldClient(url, tokens.field),
    architect: new FieldClient(url, tokens.architect),
    core,
    pack,
  };
}

describe("field HTTP surface against pinned alphavector-re", () => {
  it("keeps the RE fixture pin at fc7e34e", () => {
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
    const { url, field } = await liveField("linux");
    const page = await fetch(url);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    const html = await page.text();
    expect(html).toMatch(/Start journey/);
    expect(html).toMatch(/data-approve/);
    expect(html).toMatch(/\/field\/journeys/);
    expect(html).toMatch(/\/field\/cards/);
    expect(html).not.toMatch(/architectControls|pick a model|edit prompt|inspect temporal|configure tool/i);
    expect(html).not.toMatch(/Desk|Shape|Director|Play|Plant|HIL|Thor|Mission Control/);

    const done = await field.completeBuyerJourneyAndCard();
    expect(done.journey.journeyKind).toBe("buyer");
    expect(done.effect.executed).toBe(true);
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

    const home = await readFile(path.join(root, "Field/HomeView.swift"), "utf8");
    expect(home).toMatch(/Start journey/);
    expect(home).toMatch(/approve/);
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
