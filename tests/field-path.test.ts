import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agents/runtime.js";
import { CardBook } from "../src/auth/cards.js";
import { computerRoot } from "../src/computer/paths.js";
import { DurableStore } from "../src/data/store.js";
import { CORE_SCHEMA_SQL } from "../src/data/sql.js";
import { EffectExecutor } from "../src/effects/executor.js";
import { AvError, AuthorizationRequiredError, PolicyDeniedError, SurfaceViolationError } from "../src/errors.js";
import { FactBook } from "../src/facts/book.js";
import { GrantBook } from "../src/grants/store.js";
import { RecordBook } from "../src/records/book.js";
import { JourneyRuntime } from "../src/journeys/runtime.js";
import { MemoryPackRegistry, PackLoader } from "../src/packs/loader.js";
import { PolicyGateway } from "../src/policy/gateway.js";
import { AskSurface } from "../src/surfaces/ask.js";
import { FieldSurface } from "../src/surfaces/field.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  expectPresentIdsDeniedWithoutRecord,
  signedRePack,
  signedRePackMutated,
} from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const REQUIRED = "condition.required";
const PREFERRED = "condition.preferred";
const AVOIDED = "condition.avoided";
const JOURNEY_REQUIRED: Record<string, string> = {
  buyer: "journey.buyer",
  seller: "journey.seller",
  listing: "journey.listing",
  transaction: "journey.transaction",
  "past-client": "journey.past-client",
};

async function reFieldStack(
  signed?: Awaited<ReturnType<typeof signedRePack>>,
  opts?: { computerBaseDir?: string },
) {
  const { anchors, binding } = signed ?? (await signedRePack());
  const loader = new PackLoader(new MemoryPackRegistry(), anchors);
  const loaded = loader.load({ tenantId: "t1", binding, actor: "architect" });
  if (!loaded.ok) throw new Error(loaded.message);
  const store = new DurableStore();
  const cards = new CardBook();
  const grants = new GrantBook();
  const journeys = new JourneyRuntime(store);
  const effects = new EffectExecutor(new PolicyGateway(), grants, cards, store);
  const ask = new AskSurface(store);
  const facts = new FactBook(opts?.computerBaseDir);
  const records = new RecordBook(opts?.computerBaseDir);
  const field = new FieldSurface(cards, store, grants, journeys, effects, ask, facts, records);
  const agents = new AgentRuntime().instantiateFromPack(loaded.loaded, "architect");
  return { pack: loaded.loaded, field, cards, store, grants, agents, ask, facts, records };
}

function putSubject(
  records: RecordBook,
  pack: { tenantId: string; binding: { recordPartyKnowledge: { recordKinds: string[] } } },
  label = "Subject",
) {
  const type = pack.binding.recordPartyKnowledge.recordKinds[0] ?? "record";
  return records.put(pack.tenantId, { type, label });
}

describe("required field path against pinned alphavector-re", () => {
  it("keeps the RE fixture pin at 5091328", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
  });

  it("requires a recordId on FactBook presentIds, put, and retract", async () => {
    const bookSrc = await readFile(path.join(REPO_ROOT, "src/facts/book.ts"), "utf8");
    expect(bookSrc).not.toMatch(/const GLOBAL/);
    expect(bookSrc).not.toMatch(/recordId \?\? GLOBAL/);
    expect(bookSrc).not.toMatch(/if \(!fact\.recordId\) continue/);
    expect(bookSrc).toMatch(/RECORD_ID_REQUIRED/);
    expect(bookSrc).toMatch(/presentIds\(tenantId: string, recordId: string\)/);
    expect(bookSrc).toMatch(/put\(tenantId: string, id: string, recordId: string\)/);
    expect(bookSrc).toMatch(/retract\(tenantId: string, id: string, recordId: string\)/);

    const facts = new FactBook();
    const missing = undefined as unknown as string;
    expect(() => facts.presentIds("t1", missing)).toThrow(AvError);
    expect(() => facts.presentIds("t1", missing)).toThrow(/Record id is required/);
    expect(() => facts.presentIds("t1", "")).toThrow(/Record id is required/);
    expect(() => facts.put("t1", "journey.buyer", missing)).toThrow(AvError);
    expect(() => facts.put("t1", "journey.buyer", missing)).toThrow(/Record id is required/);
    expect(() => facts.put("t1", "journey.buyer", "")).toThrow(/Record id is required/);
    expect(() => facts.retract("t1", "journey.buyer", missing)).toThrow(AvError);
    expect(() => facts.retract("t1", "journey.buyer", missing)).toThrow(/Record id is required/);
    expect(() => facts.retract("t1", "journey.buyer", "")).toThrow(/Record id is required/);

    facts.put("t1", "journey.buyer", "rec_a");
    facts.put("t1", "consent.dnc", "rec_a");
    facts.put("t1", "purpose.follow-up", "rec_b");
    expectPresentIdsDeniedWithoutRecord(facts, "t1");
    expect(facts.presentIds("t1", "rec_a")).toEqual(
      expect.arrayContaining(["journey.buyer", "consent.dnc"]),
    );
    expect(facts.presentIds("t1", "rec_a")).not.toContain("purpose.follow-up");
    expect(facts.presentIds("t1", "rec_b")).toEqual(["purpose.follow-up"]);
    expect(facts.presentIds("t1", "rec_b")).not.toContain("consent.dnc");
    expect(facts.presentIds("t1", "rec_never_seen")).toEqual([]);
  });

  it("fail-closes on leftover facts without recordId and still loads a clean scoped file", async () => {
    const unscoped = await mkdtemp(path.join(os.tmpdir(), "av-facts-unscoped-"));
    const unscopedPaths = computerRoot(unscoped, "t1");
    await mkdir(path.dirname(unscopedPaths.factsFile), { recursive: true });
    await writeFile(
      unscopedPaths.factsFile,
      JSON.stringify({ facts: [{ id: "journey.buyer" }, { id: "consent.dnc", recordId: "rec_a" }] }),
      "utf8",
    );
    const corrupt = new FactBook(unscoped);
    expectPresentIdsDeniedWithoutRecord(corrupt, "t1");
    expect(() => corrupt.presentIds("t1", "rec_a")).toThrow(AvError);
    expect(() => corrupt.presentIds("t1", "rec_a")).toThrow(/corrupt/i);
    try {
      corrupt.presentIds("t1", "rec_a");
      throw new Error("should have failed closed");
    } catch (err) {
      expect(err).toBeInstanceOf(AvError);
      expect((err as AvError).code).toBe("FACT_STORE_CORRUPT");
    }
    expect(() => corrupt.presentIds("t1", "rec_never_seen")).toThrow(AvError);
    expect(() => corrupt.presentIds("t1", "rec_never_seen")).toThrow(/corrupt/i);
    expect(() => corrupt.presentIds("t1", "rec_a")).toThrow(/corrupt/i);
    expectPresentIdsDeniedWithoutRecord(corrupt, "t1");

    const missing = await mkdtemp(path.join(os.tmpdir(), "av-facts-missing-"));
    const missingBook = new FactBook(missing);
    expectPresentIdsDeniedWithoutRecord(missingBook, "t1");
    expect(missingBook.presentIds("t1", "rec_a")).toEqual([]);
    expect(missingBook.presentIds("t1", "rec_never_seen")).toEqual([]);

    const empty = await mkdtemp(path.join(os.tmpdir(), "av-facts-empty-"));
    const emptyPaths = computerRoot(empty, "t1");
    await mkdir(path.dirname(emptyPaths.factsFile), { recursive: true });
    await writeFile(emptyPaths.factsFile, JSON.stringify({ facts: [] }), "utf8");
    const emptyBook = new FactBook(empty);
    expectPresentIdsDeniedWithoutRecord(emptyBook, "t1");
    expect(emptyBook.presentIds("t1", "rec_a")).toEqual([]);
    expect(emptyBook.presentIds("t1", "rec_never_seen")).toEqual([]);

    const clean = await mkdtemp(path.join(os.tmpdir(), "av-facts-scoped-"));
    const cleanPaths = computerRoot(clean, "t1");
    await mkdir(path.dirname(cleanPaths.factsFile), { recursive: true });
    await writeFile(
      cleanPaths.factsFile,
      JSON.stringify({
        facts: [
          { id: "consent.dnc", recordId: "rec_a" },
          { id: "journey.buyer", recordId: "rec_a" },
          { id: "purpose.follow-up", recordId: "rec_b" },
        ],
      }),
      "utf8",
    );
    const scoped = new FactBook(clean);
    expectPresentIdsDeniedWithoutRecord(scoped, "t1");
    expect(scoped.presentIds("t1", "rec_a")).toEqual(
      expect.arrayContaining(["consent.dnc", "journey.buyer"]),
    );
    expect(scoped.presentIds("t1", "rec_a")).not.toContain("purpose.follow-up");
    expect(scoped.presentIds("t1", "rec_b")).toEqual(["purpose.follow-up"]);
    expect(scoped.presentIds("t1", "rec_b")).not.toContain("consent.dnc");
    expect(scoped.presentIds("t1", "rec_never_seen")).toEqual([]);
  });

  it("lets a field user start and progress each pack journey kind; architect cannot", async () => {
    const { pack, field, agents, store, facts, records } = await reFieldStack();
    const kinds = pack.binding.journeyKinds.map((k) => k.id);
    expect(kinds).toEqual(["buyer", "seller", "listing", "transaction", "past-client"]);

    expect(() =>
      field.start({
        actor: "architect",
        pack,
        journeyKind: "buyer",
        objective: "Architect must not use this path",
        recordId: "rec_none",
      }),
    ).toThrow(SurfaceViolationError);
    expect(() =>
      field.progress({
        actor: "architect",
        pack,
        journeyId: "journey_none",
        note: "Architect must not progress here",
      }),
    ).toThrow(/field user/);
    expect(() =>
      field.ask({
        actor: "counsel_eval",
        pack,
        tenantId: "t1",
        text: "please read the file",
        actionClass: "read",
      }),
    ).toThrow(/field user/);

    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "inquiry",
        objective: "Generic kind is not on this pack",
        recordId: "rec_none",
      }),
    ).toThrow(/not bound on the loaded pack/);

    const rec = putSubject(records, pack);
    for (const kind of kinds) {
      facts.put("t1", JOURNEY_REQUIRED[kind]!, rec.id);
      const journey = field.start({
        actor: "field",
        pack,
        journeyKind: kind,
        objective: `Work this ${kind} journey`,
        recordId: rec.id,
      });
      expect(journey.journeyKind).toBe(kind);
      expect(journey.status).toBe("open");

      const agent =
        agents.find((a) => a.specialties.includes(kind)) ??
        agents.find((a) => a.isOrchestrator)!;
      const advanced = field.progress({
        actor: "field",
        pack,
        journeyId: journey.id,
        agent,
        actionClass: "read",
        subject: rec.id,
        note: `Advance ${kind}`,
      });
      expect(advanced.journey.status).toBe("open");
      expect(advanced.effect?.executed).toBe(true);
    }

    const home = field.home("t1");
    expect(home.journeys).toHaveLength(kinds.length);
    expect(home.journeys.map((j) => j.kind).sort()).toEqual([...kinds].sort());
    expect(home.architectControls).toEqual([]);
    expect(store.evidence.some((e) => e.kind === "journey_progress")).toBe(true);
  });

  it("keeps a denied Ask ceiling denied on retry and is not a side door", async () => {
    const { pack, field, store, agents, facts, records } = await reFieldStack();
    expect(pack.binding.askCeilings).toEqual(
      expect.arrayContaining(["licensed_judgment", "prohibited", "governance", "material_state"]),
    );

    const rec = putSubject(records, pack);
    facts.put("t1", "journey.seller", rec.id);
    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "seller",
      objective: "Work this seller journey",
      recordId: rec.id,
    });
    const req = {
      tenantId: "t1" as const,
      text: "give a licensed price opinion",
      actionClass: "licensed_judgment",
    };

    expect(() => field.ask({ actor: "field", pack, ...req })).toThrow(/Ask ceiling/);
    expect(store.evidence.some((e) => e.kind === "ask_denied")).toBe(true);
    expect(() => field.ask({ actor: "field", pack, ...req })).toThrow(/Ask ceiling/);

    const agent = agents.find((a) => a.specialties.includes("seller"))!;
    expect(() =>
      field.progress({
        actor: "field",
        pack,
        journeyId: journey.id,
        agent,
        actionClass: "licensed_judgment",
        subject: rec.id,
      }),
    ).toThrow(PolicyDeniedError);

    const progressed = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
      subject: rec.id,
    });
    expect(progressed.effect?.executed).toBe(true);

    const consoleReq = {
      tenantId: "t1" as const,
      text: "configure tool",
      actionClass: "read",
    };
    expect(() => field.ask({ actor: "field", pack, ...consoleReq })).toThrow(/architecture console/);
    expect(() => field.ask({ actor: "field", pack, ...consoleReq })).toThrow(/architecture console/);
  });

  it("makes a card deny terminal on the field path", async () => {
    const { pack, field, cards, agents, facts, records } = await reFieldStack();
    const rec = putSubject(records, pack);
    facts.put("t1", "journey.buyer", rec.id);
    facts.put("t1", "purpose.follow-up", rec.id);
    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: rec.id,
    });
    const followUp = agents.find((a) => a.name === "Follow-up")!;
    const effect = {
      actor: "field" as const,
      pack,
      journeyId: journey.id,
      agent: followUp,
      actionClass: "communicate",
      channel: "email",
      purpose: "follow-up",
      subject: rec.id,
    };

    let cardId = "";
    try {
      field.progress(effect);
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
      cardId = (err as AuthorizationRequiredError).cardId;
    }

    const home = field.home("t1");
    expect(home.inbox).toHaveLength(1);
    expect(home.inbox[0]!.cardId).toBe(cardId);
    expect(JSON.stringify(home.inbox)).not.toMatch(/architect_admin|T0|T1|T2|T3/i);
    expect(home.architectControls).toEqual([]);

    cards.issue({
      tenantId: "t1",
      kind: "architect_admin",
      actionClass: "governance",
      agentId: followUp.agentId,
      purpose: "inspect",
      subject: "runtime",
      channel: "system",
      pack,
    });
    expect(field.home("t1").inbox).toHaveLength(1);

    cards.resolve({ cardId, decision: "denied", actor: "field" });
    expect(() => field.progress(effect)).toThrow(/terminal/);
    expect(() => field.progress(effect)).toThrow(/terminal/);
  });

  it("approves an owner_instance card then executes communicate on the field path", async () => {
    const { pack, field, cards, agents, facts, records } = await reFieldStack();
    const rec = putSubject(records, pack);
    facts.put("t1", "journey.buyer", rec.id);
    facts.put("t1", "purpose.follow-up", rec.id);
    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: rec.id,
    });
    const followUp = agents.find((a) => a.name === "Follow-up")!;
    const effect = {
      actor: "field" as const,
      pack,
      journeyId: journey.id,
      agent: followUp,
      actionClass: "communicate",
      channel: "email",
      purpose: "follow-up",
      subject: rec.id,
    };

    let cardId = "";
    try {
      field.progress(effect);
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
      cardId = (err as AuthorizationRequiredError).cardId;
    }

    expect(cards.get(cardId)?.kind).toBe("owner_instance");
    const home = field.home("t1");
    expect(home.inbox).toHaveLength(1);
    expect(home.inbox[0]!.cardId).toBe(cardId);
    expect(JSON.stringify(home.inbox)).not.toMatch(/architect_admin|T0|T1|T2|T3/i);
    expect(home.architectControls).toEqual([]);

    cards.issue({
      tenantId: "t1",
      kind: "architect_admin",
      actionClass: "governance",
      agentId: followUp.agentId,
      purpose: "inspect",
      subject: "runtime",
      channel: "system",
      pack,
    });
    expect(field.home("t1").inbox).toHaveLength(1);

    cards.resolve({ cardId, decision: "approved", actor: "field" });
    const progressed = field.progress({ ...effect, approvedCardId: cardId });
    expect(progressed.effect?.executed).toBe(true);
    expect(field.home("t1").inbox).toHaveLength(0);
    expect(field.home("t1").outboundLog.some((row) => row.actionId === progressed.effect?.actionId)).toBe(
      true,
    );
  });

  it("keeps field home free of architect controls and config verbs", async () => {
    const { pack, field } = await reFieldStack();
    const home = field.home("t1");
    expect(home.architectControls).toEqual([]);
    expect(home.killSwitch.available).toBe(true);
    expect(JSON.stringify(home)).not.toMatch(/model|prompt|temporal|tool schema/i);

    field.assertFieldSafe("Send this follow-up");
    expect(() => field.assertFieldSafe("switch the model")).toThrow(/must not expose/);
    expect(() => field.assertFieldSafe("edit the prompt")).toThrow(/must not expose/);
    expect(() => field.assertFieldSafe("inspect temporal")).toThrow(/must not expose/);
    expect(() => field.assertFieldSafe("open the tool schema")).toThrow(/must not expose/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "pick a model for this buyer",
        recordId: "rec_none",
      }),
    ).toThrow(/must not expose/);
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

  it("authored journeys declare REQUIRES PREFERS AVOIDS; empty disk fail-closes the five-journey path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-authored-empty-"));
    const { pack, field, records } = await reFieldStack(undefined, { computerBaseDir: dir });
    const rec = putSubject(records, pack);
    expect(pack.binding.journeyKinds.map((k) => k.id)).toEqual([
      "buyer",
      "seller",
      "listing",
      "transaction",
      "past-client",
    ]);
    for (const kind of pack.binding.journeyKinds) {
      expect(kind.REQUIRES?.length).toBeGreaterThan(0);
      expect(() =>
        field.start({
          actor: "field",
          pack,
          journeyKind: kind.id,
          objective: `Work this ${kind.id} journey`,
          recordId: rec.id,
        }),
      ).toThrow(/REQUIRES missing/);
      expect(() =>
        field.start({
          actor: "field",
          pack,
          journeyKind: kind.id,
          objective: `Work this ${kind.id} journey`,
          recordId: rec.id,
        }),
      ).toThrow(/fail closed/);
    }
  });

  it("authored buyer start fails closed without on-disk journey.buyer; a request claim does not satisfy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-authored-claim-"));
    const { pack, field, records } = await reFieldStack(undefined, { computerBaseDir: dir });
    const rec = putSubject(records, pack);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
      }),
    ).toThrow(/REQUIRES missing/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
        conditions: ["journey.buyer"],
      }),
    ).toThrow(/REQUIRES missing/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
        conditions: ["journey.buyer"],
      }),
    ).toThrow(/fail closed/);
    expect(existsSync(computerRoot(dir, "t1").factsFile)).toBe(false);
  });

  it("approved record of journey.buyer then starts buyer; seller and communicate need their authored facts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-authored-record-"));
    const { pack, field, cards, agents, facts, records } = await reFieldStack(undefined, {
      computerBaseDir: dir,
    });
    const paths = computerRoot(dir, "t1");
    const buyerRec = putSubject(records, pack, "Buyer subject");
    const sellerRec = putSubject(records, pack, "Seller subject");

    let buyerCard = "";
    try {
      field.record({ actor: "field", pack, id: "journey.buyer", recordId: buyerRec.id });
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
      buyerCard = (err as AuthorizationRequiredError).cardId;
    }
    expect(cards.get(buyerCard)?.kind).toBe("owner_instance");
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);

    cards.resolve({ cardId: buyerCard, decision: "approved", actor: "field" });
    expect(field.commitApprovedFact(buyerCard)).toEqual({
      id: "journey.buyer",
      present: true,
      recordId: buyerRec.id,
    });
    expect(paths.factsFile).toBe(path.join(dir, "tenants", "t1", "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), "t1");
    expect(new FactBook(dir).presentIds("t1", buyerRec.id)).toEqual(["journey.buyer"]);

    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: buyerRec.id,
    });
    expect(journey.status).toBe("open");

    facts.put("t1", "journey.seller", sellerRec.id);
    const seller = field.start({
      actor: "field",
      pack,
      journeyKind: "seller",
      objective: "Work this seller journey",
      recordId: sellerRec.id,
    });
    expect(seller.journeyKind).toBe("seller");

    const followUp = agents.find((a) => a.name === "Follow-up")!;
    const effect = {
      actor: "field" as const,
      pack,
      journeyId: journey.id,
      agent: followUp,
      actionClass: "communicate",
      channel: "email",
      purpose: "follow-up",
      subject: buyerRec.id,
    };
    expect(() => field.progress(effect)).toThrow(/REQUIRES missing/);
    facts.put("t1", "purpose.follow-up", buyerRec.id);
    expect(() => field.progress(effect)).toThrow(
      AuthorizationRequiredError,
    );
  });

  it("authored AVOIDS fail closed when consent.dnc is on disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-authored-avoid-"));
    const { pack, field, facts, records } = await reFieldStack(undefined, { computerBaseDir: dir });
    const rec = putSubject(records, pack);
    facts.put("t1", "journey.buyer", rec.id);
    facts.put("t1", "consent.dnc", rec.id);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
      }),
    ).toThrow(/AVOIDS present/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
      }),
    ).toThrow(/fail closed/);
  });

  it("denies a request-only REQUIRES claim and allows only an on-disk fact", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-req-"));
    const { pack, field, agents, facts, records } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.REQUIRES = [REQUIRED];
        const read = unsigned.actionClassVerbs.find((v) => v.id === "read");
        if (read) read.REQUIRES = [REQUIRED];
      }),
      { computerBaseDir: dir },
    );
    const rec = putSubject(records, pack);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
      }),
    ).toThrow(/REQUIRES missing/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
        conditions: [REQUIRED],
      }),
    ).toThrow(/REQUIRES missing/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
        conditions: [REQUIRED],
      }),
    ).toThrow(/fail closed/);

    const paths = computerRoot(dir, "t1");
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);

    facts.put("t1", REQUIRED, rec.id);
    expect(paths.factsFile).toBe(path.join(dir, "tenants", "t1", "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), "t1");
    expect(new FactBook(dir).presentIds("t1", rec.id)).toEqual([REQUIRED]);

    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: rec.id,
    });
    const agent = agents.find((a) => a.specialties.includes("buyer"))!;
    const advanced = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
      subject: rec.id,
    });
    expect(advanced.effect?.executed).toBe(true);
  });

  it("fail-closes start and progress when an on-disk AVOIDS fact is present", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-avoid-"));
    const { pack, field, agents, facts, records } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.AVOIDS = [AVOIDED];
        const read = unsigned.actionClassVerbs.find((v) => v.id === "read");
        if (read) read.AVOIDS = [AVOIDED];
      }),
      { computerBaseDir: dir },
    );
    const rec = putSubject(records, pack);
    facts.put("t1", "journey.buyer", rec.id);
    const open = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: rec.id,
      conditions: [AVOIDED],
    });
    expect(open.status).toBe("open");

    facts.put("t1", AVOIDED, rec.id);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
      }),
    ).toThrow(/AVOIDS present/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
      }),
    ).toThrow(/fail closed/);

    const agent = agents.find((a) => a.specialties.includes("buyer"))!;
    expect(() =>
      field.progress({
        actor: "field",
        pack,
        journeyId: open.id,
        agent,
        actionClass: "read",
        subject: rec.id,
      }),
    ).toThrow(/AVOIDS present/);
  });

  it("records PREFERS on the field path and does not fail closed when unmet", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-pref-"));
    const { pack, field, agents, store, facts, records } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.PREFERS = [PREFERRED];
        const read = unsigned.actionClassVerbs.find((v) => v.id === "read");
        if (read) read.PREFERS = [PREFERRED];
      }),
      { computerBaseDir: dir },
    );
    const rec = putSubject(records, pack);
    facts.put("t1", "journey.buyer", rec.id);
    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: rec.id,
    });
    expect(journey.status).toBe("open");
    const agent = agents.find((a) => a.specialties.includes("buyer"))!;
    const unmet = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
      subject: rec.id,
    });
    expect(unmet.effect?.executed).toBe(true);
    expect(unmet.recordedPrefers).toEqual([PREFERRED]);
    expect(store.evidence.some((e) => e.kind === "journey_progress" && e.payload.recordedPrefers)).toBe(
      true,
    );

    facts.put("t1", PREFERRED, rec.id);
    const met = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
      subject: rec.id,
      conditions: [PREFERRED],
    });
    expect(met.effect?.executed).toBe(true);
    expect(met.recordedPrefers).toEqual([PREFERRED]);
  });

  it("records and retracts a fact only after an owner_instance card is approved", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-write-"));
    const { pack, field, cards, agents, facts, records } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.REQUIRES = [REQUIRED];
      }),
      { computerBaseDir: dir },
    );
    const paths = computerRoot(dir, "t1");
    const rec = putSubject(records, pack);
    const write = { actor: "field" as const, pack, id: REQUIRED, recordId: rec.id };

    expect(() =>
      field.record({ actor: "architect", pack, id: REQUIRED, recordId: rec.id }),
    ).toThrow(SurfaceViolationError);

    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
      }),
    ).toThrow(/REQUIRES missing/);

    let cardId = "";
    try {
      field.record(write);
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
      cardId = (err as AuthorizationRequiredError).cardId;
    }

    expect(cards.get(cardId)?.kind).toBe("owner_instance");
    expect(cards.get(cardId)?.status).toBe("pending");
    expect(field.home("t1").inbox).toHaveLength(1);
    expect(field.home("t1").inbox[0]!.cardId).toBe(cardId);
    expect(JSON.stringify(field.home("t1").inbox)).not.toMatch(/architect_admin|T0|T1|T2|T3/i);
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expectPresentIdsDeniedWithoutRecord(facts, "t1");
    expect(() => field.commitApprovedFact(cardId)).toThrow(/approved card/);
    expect(existsSync(paths.factsFile)).toBe(false);

    cards.resolve({ cardId, decision: "approved", actor: "field" });
    const recorded = field.commitApprovedFact(cardId);
    expect(recorded).toEqual({ id: REQUIRED, present: true, recordId: rec.id });
    expect(paths.factsFile).toBe(path.join(dir, "tenants", "t1", "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), "t1");
    expect(new FactBook(dir).presentIds("t1", rec.id)).toEqual([REQUIRED]);

    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: rec.id,
    });
    const agent = agents.find((a) => a.specialties.includes("buyer"))!;
    const advanced = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
      subject: rec.id,
    });
    expect(advanced.effect?.executed).toBe(true);

    let retractId = "";
    try {
      field.retract(write);
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
      retractId = (err as AuthorizationRequiredError).cardId;
    }
    expect(new FactBook(dir).presentIds("t1", rec.id)).toEqual([REQUIRED]);
    expect(existsSync(paths.factsFile)).toBe(true);

    cards.resolve({ cardId: retractId, decision: "approved", actor: "field" });
    expect(field.commitApprovedFact(retractId)).toEqual({
      id: REQUIRED,
      present: false,
      recordId: rec.id,
    });
    expect(new FactBook(dir).presentIds("t1", rec.id)).toEqual([]);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
      }),
    ).toThrow(/REQUIRES missing/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
      }),
    ).toThrow(/fail closed/);
  });

  it("keeps a denied fact write terminal and off disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-deny-"));
    const { pack, field, cards, records } = await reFieldStack(undefined, { computerBaseDir: dir });
    const paths = computerRoot(dir, "t1");
    const rec = putSubject(records, pack);
    const write = { actor: "field" as const, pack, id: REQUIRED, recordId: rec.id };

    let cardId = "";
    try {
      field.record(write);
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
      cardId = (err as AuthorizationRequiredError).cardId;
    }

    cards.resolve({ cardId, decision: "denied", actor: "field" });
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(() => field.commitApprovedFact(cardId)).toThrow(/approved card/);
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(() => field.record(write)).toThrow(/terminal/);
    expect(() => field.record(write)).toThrow(/terminal/);
    expect(existsSync(paths.factsFile)).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), "t1");
  });

  it("fail-closes on a corrupt fact store and does not invent a fact", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-bad-"));
    const paths = computerRoot(dir, "t1");
    await mkdir(path.dirname(paths.factsFile), { recursive: true });
    await writeFile(paths.factsFile, "{not-json", "utf8");
    const signed = await signedRePackMutated((unsigned) => {
      const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
      if (buyer) buyer.REQUIRES = [REQUIRED];
    });
    const { pack, field, records } = await reFieldStack(signed, { computerBaseDir: dir });
    const rec = putSubject(records, pack);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
      }),
    ).toThrow(AvError);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: rec.id,
        conditions: [REQUIRED],
      }),
    ).toThrow(/corrupt/i);

    const guessed = await mkdtemp(path.join(os.tmpdir(), "av-facts-guess-"));
    const guessPath = computerRoot(guessed, "t1");
    await mkdir(path.dirname(guessPath.factsFile), { recursive: true });
    await writeFile(
      guessPath.factsFile,
      JSON.stringify({ facts: [{ required: true }] }),
      "utf8",
    );
    const guessedStack = await reFieldStack(signed, { computerBaseDir: guessed });
    const guessedRec = putSubject(guessedStack.records, guessedStack.pack);
    expect(() =>
      guessedStack.field.start({
        actor: "field",
        pack: guessedStack.pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: guessedRec.id,
        conditions: [REQUIRED],
      }),
    ).toThrow(/corrupt/i);
  });

  it("creates a record only after approve; DNC on A blocks communicate about A not B", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-records-subject-"));
    const { pack, field, cards, agents, facts, records } = await reFieldStack(undefined, {
      computerBaseDir: dir,
    });
    const paths = computerRoot(dir, "t1");
    const type = pack.binding.recordPartyKnowledge.recordKinds[0] ?? "record";
    expect(type).not.toMatch(/listing_id|person_id|household_id|buyer_id/i);

    expect(() =>
      field.create({ actor: "architect", pack, type, label: "A" }),
    ).toThrow(SurfaceViolationError);

    let createA = "";
    try {
      field.create({ actor: "field", pack, type, label: "A" });
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
      createA = (err as AuthorizationRequiredError).cardId;
    }
    expect(cards.get(createA)?.kind).toBe("owner_instance");
    expect(existsSync(paths.recordsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "records.json"))).toBe(false);
    expect(records.list("t1")).toEqual([]);
    expect(() => field.commitApprovedFact(createA)).toThrow(/approved card/);
    expect(existsSync(paths.recordsFile)).toBe(false);

    cards.resolve({ cardId: createA, decision: "approved", actor: "field" });
    const recordedA = field.commitApprovedFact(createA);
    expect(recordedA?.present).toBe(true);
    expect(recordedA?.id).toMatch(/^rec_/);
    expect(paths.recordsFile).toBe(path.join(dir, "tenants", "t1", "records.json"));
    expect(existsSync(paths.recordsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "records.json"))).toBe(false);
    const recA = records.get("t1", recordedA!.id)!;
    expect(recA).toEqual({ id: recordedA!.id, type, label: "A", attributes: {} });

    let createB = "";
    try {
      field.create({ actor: "field", pack, type, label: "B" });
      throw new Error("should have required a card");
    } catch (err) {
      createB = (err as AuthorizationRequiredError).cardId;
    }
    cards.resolve({ cardId: createB, decision: "approved", actor: "field" });
    const recordedB = field.commitApprovedFact(createB);
    const recB = records.get("t1", recordedB!.id)!;
    expect(recB.label).toBe("B");

    const recJourney = records.put("t1", { type, label: "Journey" });
    facts.put("t1", "journey.buyer", recJourney.id);
    facts.put("t1", "purpose.follow-up", recA.id);
    facts.put("t1", "consent.dnc", recA.id);
    facts.put("t1", "purpose.follow-up", recB.id);
    expectPresentIdsDeniedWithoutRecord(facts, "t1");
    expect(facts.presentIds("t1", recJourney.id)).toEqual(["journey.buyer"]);
    expect(facts.presentIds("t1", recA.id)).toEqual(
      expect.arrayContaining(["purpose.follow-up", "consent.dnc"]),
    );
    expect(facts.presentIds("t1", recB.id)).toEqual(["purpose.follow-up"]);
    expect(facts.presentIds("t1", recB.id)).not.toContain("consent.dnc");

    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: recJourney.id,
    });
    const followUp = agents.find((a) => a.name === "Follow-up")!;
    const communicate = {
      actor: "field" as const,
      pack,
      journeyId: journey.id,
      agent: followUp,
      actionClass: "communicate",
      channel: "email",
      purpose: "follow-up",
    };
    expect(() => field.progress({ ...communicate, subject: recA.id })).toThrow(/AVOIDS present/);
    expect(() => field.progress({ ...communicate, subject: recA.id })).toThrow(/fail closed/);
    expect(() => field.progress({ ...communicate, subject: recB.id })).toThrow(
      AuthorizationRequiredError,
    );
  });

  it("denies action progress with no subject and unknown subject", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-action-subject-required-"));
    const { pack, field, agents, facts, records } = await reFieldStack(undefined, {
      computerBaseDir: dir,
    });
    const rec = putSubject(records, pack);
    facts.put("t1", "journey.buyer", rec.id);
    facts.put("t1", "purpose.follow-up", rec.id);
    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: rec.id,
    });
    const followUp = agents.find((a) => a.name === "Follow-up")!;
    const communicate = {
      actor: "field" as const,
      pack,
      journeyId: journey.id,
      agent: followUp,
      actionClass: "communicate",
      channel: "email",
      purpose: "follow-up",
    };

    expect(() => field.progress(communicate)).toThrow(AvError);
    expect(() => field.progress(communicate)).toThrow(/Record id is required/);
    expect(() => field.progress({ ...communicate, subject: "" })).toThrow(/Record id is required/);
    expect(() => field.progress({ ...communicate, subject: "buyer" })).toThrow(AvError);
    expect(() => field.progress({ ...communicate, subject: "buyer" })).toThrow(/Unknown record/);
    expect(() => field.progress({ ...communicate, subject: "rec_unknown" })).toThrow(
      /Unknown record/,
    );
    expect(() => field.progress({ ...communicate, subject: rec.id })).toThrow(
      AuthorizationRequiredError,
    );
  });

  it("open on A allows start about A and leaves start about B closed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-journey-open-a-not-b-"));
    const { pack, field, cards, records } = await reFieldStack(undefined, {
      computerBaseDir: dir,
    });
    const type = pack.binding.recordPartyKnowledge.recordKinds[0] ?? "record";
    const putRecord = (label: string) => {
      let cardId = "";
      try {
        field.create({ actor: "field", pack, type, label });
        throw new Error("should have required a card");
      } catch (err) {
        cardId = (err as AuthorizationRequiredError).cardId;
      }
      cards.resolve({ cardId, decision: "approved", actor: "field" });
      return field.commitApprovedFact(cardId)!.id;
    };
    const recA = putRecord("A");
    const recB = putRecord("B");

    let openA = "";
    try {
      field.record({ actor: "field", pack, id: "journey.buyer", recordId: recA });
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
      openA = (err as AuthorizationRequiredError).cardId;
    }
    expect(existsSync(computerRoot(dir, "t1").factsFile)).toBe(false);
    expect(new FactBook(dir).presentIds("t1", recA)).toEqual([]);

    cards.resolve({ cardId: openA, decision: "approved", actor: "field" });
    expect(field.commitApprovedFact(openA)).toEqual({
      id: "journey.buyer",
      present: true,
      recordId: recA,
    });
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), "t1");
    expect(new FactBook(dir).presentIds("t1", recA)).toEqual(["journey.buyer"]);
    expect(new FactBook(dir).presentIds("t1", recB)).toEqual([]);

    const startedA = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: recA,
    });
    expect(startedA.status).toBe("open");
    expect(startedA.recordId).toBe(recA);
    expect(records.has("t1", recA)).toBe(true);

    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: recB,
      }),
    ).toThrow(/REQUIRES missing/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: recB,
      }),
    ).toThrow(/fail closed/);
  });

  it("denies start with no recordId and unknown recordId", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-start-record-required-"));
    const { pack, field, facts, records } = await reFieldStack(undefined, {
      computerBaseDir: dir,
    });
    const rec = putSubject(records, pack);
    facts.put("t1", "journey.buyer", rec.id);

    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: "" as string,
      }),
    ).toThrow(AvError);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: "" as string,
      }),
    ).toThrow(/Record id is required/);

    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: "rec_unknown",
      }),
    ).toThrow(AvError);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        recordId: "rec_unknown",
      }),
    ).toThrow(/Unknown record/);

    const started = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      recordId: rec.id,
    });
    expect(started.status).toBe("open");
    expect(started.recordId).toBe(rec.id);
  });

  it("denies Open of journey.* with no recordId and unknown recordId", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-open-record-required-"));
    const { pack, field, records } = await reFieldStack(undefined, { computerBaseDir: dir });
    const rec = putSubject(records, pack);
    const paths = computerRoot(dir, "t1");

    expect(() =>
      field.record({ actor: "field", pack, id: "journey.buyer", recordId: "" }),
    ).toThrow(AvError);
    expect(() =>
      field.record({ actor: "field", pack, id: "journey.buyer", recordId: "" }),
    ).toThrow(/Record id is required/);
    expect(existsSync(paths.factsFile)).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), "t1");

    expect(() =>
      field.record({ actor: "field", pack, id: "journey.buyer", recordId: "rec_unknown" }),
    ).toThrow(/Unknown record/);
    expect(existsSync(paths.factsFile)).toBe(false);

    try {
      field.record({ actor: "field", pack, id: "journey.buyer", recordId: rec.id });
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
    }
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(new FactBook(dir).presentIds("t1", rec.id)).toEqual([]);
  });

  it("denies record and retract of purpose, AVOIDS, and generic facts without a known record", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-fact-record-required-"));
    const { pack, field, records } = await reFieldStack(undefined, { computerBaseDir: dir });
    const rec = putSubject(records, pack);
    const paths = computerRoot(dir, "t1");
    const ids = ["purpose.follow-up", "consent.dnc", REQUIRED] as const;

    for (const id of ids) {
      for (const op of ["record", "retract"] as const) {
        expect(() => field[op]({ actor: "field", pack, id, recordId: "" })).toThrow(AvError);
        expect(() => field[op]({ actor: "field", pack, id, recordId: "" })).toThrow(
          /Record id is required/,
        );
        expect(() => field[op]({ actor: "field", pack, id, recordId: "rec_unknown" })).toThrow(
          AvError,
        );
        expect(() => field[op]({ actor: "field", pack, id, recordId: "rec_unknown" })).toThrow(
          /Unknown record/,
        );
      }
      expect(existsSync(paths.factsFile)).toBe(false);
      expectPresentIdsDeniedWithoutRecord(new FactBook(dir), "t1");
      expect(new FactBook(dir).presentIds("t1", rec.id)).toEqual([]);
    }

    try {
      field.record({ actor: "field", pack, id: REQUIRED, recordId: rec.id });
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
    }
    expect(existsSync(paths.factsFile)).toBe(false);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), "t1");
    expect(new FactBook(dir).presentIds("t1", rec.id)).toEqual([]);
  });

  it("fail-closes on a corrupt record store and does not invent a record", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-records-bad-"));
    const paths = computerRoot(dir, "t1");
    await mkdir(path.dirname(paths.recordsFile), { recursive: true });
    await writeFile(paths.recordsFile, "{not-json", "utf8");
    const { pack, field } = await reFieldStack(undefined, { computerBaseDir: dir });
    expect(() => field.home("t1", pack)).toThrow(AvError);
    expect(() => field.home("t1", pack)).toThrow(/corrupt/i);
    expect(() =>
      field.create({ actor: "field", pack, type: "record", label: "A" }),
    ).toThrow(/corrupt/i);
  });

  it("fail-closes on incomplete attribute rows and does not invent keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-records-attr-bad-"));
    const paths = computerRoot(dir, "t1");
    await mkdir(path.dirname(paths.recordsFile), { recursive: true });
    await writeFile(
      paths.recordsFile,
      JSON.stringify({
        records: [{ id: "rec_a", type: "record", label: "A", attributes: { note: 1 } }],
      }),
      "utf8",
    );
    const { field, pack } = await reFieldStack(undefined, { computerBaseDir: dir });
    expect(() => field.home("t1", pack)).toThrow(AvError);
    expect(() => field.home("t1", pack)).toThrow(/corrupt|incomplete/i);
    expect(() => new RecordBook(dir).list("t1")).toThrow(/corrupt|incomplete/i);
  });

  it("updates label, type, and attributes only after approve; missing recordId fails closed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-records-attrs-"));
    const { pack, field, cards, records, facts } = await reFieldStack(undefined, {
      computerBaseDir: dir,
    });
    const paths = computerRoot(dir, "t1");
    const type = pack.binding.recordPartyKnowledge.recordKinds[0] ?? "record";
    const otherType = pack.binding.recordPartyKnowledge.recordKinds[1] ?? `${type}-other`;

    let createId = "";
    try {
      field.create({ actor: "field", pack, type, label: "A" });
      throw new Error("should have required a card");
    } catch (err) {
      createId = (err as AuthorizationRequiredError).cardId;
    }
    cards.resolve({ cardId: createId, decision: "approved", actor: "field" });
    const created = field.commitApprovedFact(createId)!;
    const recId = created.id;
    expect(records.get("t1", recId)).toEqual({
      id: recId,
      type,
      label: "A",
      attributes: {},
    });

    expect(() =>
      field.update({ actor: "architect", pack, recordId: recId, attributes: { note: "x" } }),
    ).toThrow(SurfaceViolationError);

    expect(() =>
      field.update({ actor: "field", pack, recordId: "", attributes: { note: "x" } }),
    ).toThrow(AvError);
    expect(() =>
      field.update({ actor: "field", pack, recordId: "", attributes: { note: "x" } }),
    ).toThrow(/Record id is required/);
    expect(() =>
      field.update({ actor: "field", pack, recordId: "rec_unknown", attributes: { note: "x" } }),
    ).toThrow(/Unknown record/);

    let deniedAttr = "";
    try {
      field.update({ actor: "field", pack, recordId: recId, attributes: { other: "no" } });
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
      deniedAttr = (err as AuthorizationRequiredError).cardId;
    }
    expect(cards.get(deniedAttr)?.kind).toBe("owner_instance");
    expect(records.get("t1", recId)?.attributes).toEqual({});
    expect(JSON.parse(await readFile(paths.recordsFile, "utf8")).records[0].attributes).toEqual({});
    expect(() => field.commitApprovedFact(deniedAttr)).toThrow(/approved card/);
    expect(new RecordBook(dir).get("t1", recId)?.attributes).toEqual({});

    cards.resolve({ cardId: deniedAttr, decision: "denied", actor: "field" });
    expect(records.get("t1", recId)?.attributes).toEqual({});
    expect(new RecordBook(dir).get("t1", recId)?.attributes).toEqual({});

    let approvedAttr = "";
    try {
      field.update({ actor: "field", pack, recordId: recId, attributes: { note: "hello" } });
      throw new Error("should have required a card");
    } catch (err) {
      approvedAttr = (err as AuthorizationRequiredError).cardId;
    }
    expect(() => field.commitApprovedFact(approvedAttr)).toThrow(/approved card/);
    expect(new RecordBook(dir).get("t1", recId)?.attributes).toEqual({});
    cards.resolve({ cardId: approvedAttr, decision: "approved", actor: "field" });
    expect(field.commitApprovedFact(approvedAttr)).toEqual({ id: recId, present: true });
    expect(records.get("t1", recId)?.attributes).toEqual({ note: "hello" });
    expect(new RecordBook(dir).get("t1", recId)).toEqual({
      id: recId,
      type,
      label: "A",
      attributes: { note: "hello" },
    });

    let labelCard = "";
    try {
      field.update({ actor: "field", pack, recordId: recId, label: "Renamed", type: otherType });
      throw new Error("should have required a card");
    } catch (err) {
      labelCard = (err as AuthorizationRequiredError).cardId;
    }
    expect(records.get("t1", recId)?.label).toBe("A");
    expect(records.get("t1", recId)?.type).toBe(type);
    cards.resolve({ cardId: labelCard, decision: "approved", actor: "field" });
    field.commitApprovedFact(labelCard);
    const restarted = new RecordBook(dir).get("t1", recId);
    expect(restarted).toEqual({
      id: recId,
      type: otherType,
      label: "Renamed",
      attributes: { note: "hello" },
    });

    facts.put("t1", "journey.buyer", recId);
    expectPresentIdsDeniedWithoutRecord(new FactBook(dir), "t1");
    expect(new FactBook(dir).presentIds("t1", recId)).toEqual(["journey.buyer"]);
    expect(existsSync(path.join(paths.disk, "records.json"))).toBe(false);
  });
});
