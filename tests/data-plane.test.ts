import { describe, expect, it } from "vitest";
import { DurableStore } from "../src/data/store.js";
import { CORE_SCHEMA_SQL } from "../src/data/sql.js";

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
