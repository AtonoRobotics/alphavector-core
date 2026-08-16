import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CardBook } from "../src/auth/cards.js";
import { DurableStore, LEDGER_RELATION_NAMES } from "../src/data/store.js";
import { CORE_SCHEMA_SQL } from "../src/data/sql.js";
import { AvError } from "../src/errors.js";
import { GrantBook } from "../src/grants/store.js";
import { AlphaVectorCore } from "../src/kernel.js";
import { FieldSurface } from "../src/surfaces/field.js";
import { ALPHAVECTOR_RE_PIN_SHA, makeAnchors } from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";

function isolatedSchema(): string {
  return `av_restart_${randomBytes(8).toString("hex")}`;
}

describe("data plane DEC-026", () => {
  it("owns generic party/record/journey slots", () => {
    const store = new DurableStore();
    const party = store.createParty("t1", "contact", "Alex");
    const rec = store.createRecord("t1", "artifact", { title: "note" });
    const journey = store.createJourney("t1", "inquiry", "Find the answer");
    expect(party.partyKind).toBe("contact");
    expect(rec.recordKind).toBe("artifact");
    expect(journey.journeyKind).toBe("inquiry");
    expect(CORE_SCHEMA_SQL).toContain("party_kind");
    expect(CORE_SCHEMA_SQL).toContain("record_kind");
    expect(CORE_SCHEMA_SQL).not.toMatch(/listing_id|person_id|household_id/i);
  });

  it("models cannot write verified assertions", () => {
    const store = new DurableStore();
    expect(() =>
      store.assert({
        tenantId: "t1",
        subjectType: "contact",
        subjectId: "p1",
        predicate: "mentions",
        typedValue: "x",
        classification: "verified",
        confidence: 0.9,
        sourceType: "model",
        sourceId: "m1",
        sourceActor: "model",
        actorIsModel: true,
      }),
    ).toThrow(/SHALL NOT write verified/);
  });

  it("evidence is immutable", () => {
    const store = new DurableStore();
    const ev = store.addEvidence({
      tenantId: "t1",
      kind: "note",
      payload: { ok: true },
      producedBy: "agent-1",
    });
    expect(() => store.mutateEvidence(ev.id)).toThrow(/cannot modify or delete/);
    expect(() => store.deleteEvidence(ev.id)).toThrow(/cannot modify or delete/);
  });

  it("retrieval stays tenant-scoped", () => {
    const store = new DurableStore();
    store.createParty("t1", "contact", "Alex");
    store.createParty("t2", "contact", "Alex");
    expect(store.retrieve("t1", "alex")).toHaveLength(1);
  });
});

describe("DEC-005 PostgreSQL ledger", () => {
  it("keeps the RE fixture pin at 5091328 and does not hardcode a vendor host", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const sqlSrc = readFileSync(fileURLToPath(new URL("../src/data/sql.ts", import.meta.url)), "utf8");
    expect(sqlSrc).toMatch(/PostgreSQL schema\. Production business truth \(DEC-005\)/);
    expect(sqlSrc).toMatch(/Pack kinds are data, not columns/);
    const src = `${sqlSrc}\n${readFileSync(
      fileURLToPath(new URL("../src/data/store.ts", import.meta.url)),
      "utf8",
    )}`;
    expect(src).not.toMatch(/api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com/i);
  });

  it("missing DATABASE_URL fails closed with a typed refusal", () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => new DurableStore({ env: {} })).toThrow(AvError);
      try {
        new DurableStore({ env: { DATABASE_URL: "   " } });
        expect.fail("blank DATABASE_URL must fail closed");
      } catch (err) {
        expect(err).toBeInstanceOf(AvError);
        expect((err as AvError).code).toBe("DATABASE_URL_REQUIRED");
        expect((err as AvError).closed).toBe(true);
        expect((err as AvError).message).toMatch(/in-process ledger/i);
      }
      expect(() => new AlphaVectorCore(makeAnchors().anchors)).toThrow(AvError);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  it("applies the schema so ledger tables exist", () => {
    const store = new DurableStore();
    const names = store.appliedRelationNames();
    for (const table of LEDGER_RELATION_NAMES) {
      expect(names).toContain(table);
    }
    expect(names).toContain("grants");
    expect(names).toContain("auth_cards");
  });

  it("a fresh store on the same DATABASE_URL still has the business rows", () => {
    const schema = isolatedSchema();
    const first = new DurableStore({ schema });
    const party = first.createParty("t1", "contact", "Alex");
    const rec = first.createRecord("t1", "artifact", { title: "note" });
    const journey = first.createJourney("t1", "inquiry", "Find the answer", rec.id);
    const assertion = first.assert({
      tenantId: "t1",
      subjectType: "record",
      subjectId: rec.id,
      predicate: "mentions",
      typedValue: { text: "note" },
      classification: "observed",
      confidence: 0.8,
      sourceType: "user",
      sourceId: "field",
      sourceActor: "field",
    });
    const action = first.proposeAction({
      tenantId: "t1",
      actionClass: "communicate",
      agentId: "agent-1",
      channel: "email",
      purpose: "follow-up",
      subjectId: rec.id,
    });
    first.updateAction(action.id, "executed");
    const evidence = first.addEvidence({
      tenantId: "t1",
      kind: "note",
      payload: { ok: true },
      producedBy: "agent-1",
    });
    const outcome = first.addOutcome("t1", action.id, "Reached the world");
    const commitment = first.addCommitment("t1", [party.id], "2026-08-17T00:00:00.000Z");
    const interaction = first.addInteraction("t1", "email", [party.id], "Wrote the note");
    const node = first.projectNode("t1", "record", rec.id);
    const edge = first.projectEdge({
      tenantId: "t1",
      kind: "about",
      fromId: node.nodeId,
      toId: party.id,
      assertionId: assertion.id,
    });

    const second = new DurableStore({ schema });
    expect(second.parties.map((row) => row.id)).toEqual([party.id]);
    expect(second.parties[0]?.displayName).toBe("Alex");
    expect(second.records.map((row) => row.id)).toEqual([rec.id]);
    expect(second.records[0]?.payload).toEqual({ title: "note" });
    expect(second.journeys.map((row) => row.id)).toEqual([journey.id]);
    expect(second.journeys[0]?.recordId).toBe(rec.id);
    expect(second.assertions.map((row) => row.id)).toEqual([assertion.id]);
    expect(second.actions.map((row) => row.id)).toEqual([action.id]);
    expect(second.actions[0]?.status).toBe("executed");
    expect(second.evidence.map((row) => row.id)).toEqual([evidence.id]);
    expect(second.outcomes.map((row) => row.id)).toEqual([outcome.id]);
    expect(second.commitments.map((row) => row.id)).toEqual([commitment.id]);
    expect(second.commitments[0]?.parties).toEqual([party.id]);
    expect(second.interactions.map((row) => row.id)).toEqual([interaction.id]);
    expect(second.nodes.map((row) => row.nodeId)).toEqual([node.nodeId]);
    expect(second.edges.map((row) => row.edgeId)).toEqual([edge.edgeId]);
  });

  it("field home reads persisted journeys and executed actions after restart", () => {
    const schema = isolatedSchema();
    const first = new DurableStore({ schema });
    const journey = first.createJourney("t1", "inquiry", "Keep this");
    const action = first.proposeAction({
      tenantId: "t1",
      actionClass: "read",
      agentId: "agent-1",
    });
    first.updateAction(action.id, "executed");

    const second = new DurableStore({ schema });
    const field = new FieldSurface(new CardBook(), second, new GrantBook());
    const home = field.home("t1");
    expect(home.journeys).toEqual([
      { id: journey.id, kind: "inquiry", objective: "Keep this" },
    ]);
    expect(home.outboundLog).toEqual([{ actionId: action.id, summary: "read" }]);
  });
});
