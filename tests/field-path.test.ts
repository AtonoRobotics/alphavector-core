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
import { JourneyRuntime } from "../src/journeys/runtime.js";
import { MemoryPackRegistry, PackLoader } from "../src/packs/loader.js";
import { PolicyGateway } from "../src/policy/gateway.js";
import { AskSurface } from "../src/surfaces/ask.js";
import { FieldSurface } from "../src/surfaces/field.js";
import {
  ALPHAVECTOR_RE_PIN_SHA,
  REPO_ROOT,
  signedRePack,
  signedRePackMutated,
} from "./helpers.js";

const RE_PIN = "84f1410e9735882551f3ec3e77dea94aa096bdf2";
const REQUIRED = "condition.required";
const PREFERRED = "condition.preferred";
const AVOIDED = "condition.avoided";

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
  const field = new FieldSurface(cards, store, grants, journeys, effects, ask, facts);
  const agents = new AgentRuntime().instantiateFromPack(loaded.loaded, "architect");
  return { pack: loaded.loaded, field, cards, store, grants, agents, ask, facts };
}

describe("required field path against pinned alphavector-re", () => {
  it("keeps the RE fixture pin at 84f1410", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
  });

  it("lets a field user start and progress each pack journey kind; architect cannot", async () => {
    const { pack, field, agents, store } = await reFieldStack();
    const kinds = pack.binding.journeyKinds.map((k) => k.id);
    expect(kinds).toEqual(["buyer", "seller", "listing", "transaction", "past-client"]);

    expect(() =>
      field.start({
        actor: "architect",
        pack,
        journeyKind: "buyer",
        objective: "Architect must not use this path",
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
      }),
    ).toThrow(/not bound on the loaded pack/);

    for (const kind of kinds) {
      const journey = field.start({
        actor: "field",
        pack,
        journeyKind: kind,
        objective: `Work this ${kind} journey`,
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
    const { pack, field, store, agents } = await reFieldStack();
    expect(pack.binding.askCeilings).toEqual(
      expect.arrayContaining(["licensed_judgment", "prohibited", "governance", "material_state"]),
    );

    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "seller",
      objective: "Work this seller journey",
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
      }),
    ).toThrow(PolicyDeniedError);

    const progressed = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
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
    const { pack, field, cards, agents } = await reFieldStack();
    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
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
      subject: "buyer",
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
    const { pack, field, cards, agents } = await reFieldStack();
    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
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
      subject: "buyer",
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

  it("authored journeys have no declarations so the five-journey field path stays open", async () => {
    const { pack, field, agents } = await reFieldStack();
    for (const kind of pack.binding.journeyKinds) {
      expect(kind).toEqual({ id: kind.id, label: kind.label });
      expect(kind.REQUIRES).toBeUndefined();
      expect(kind.PREFERS).toBeUndefined();
      expect(kind.AVOIDS).toBeUndefined();
    }
    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
    });
    const agent = agents.find((a) => a.specialties.includes("buyer"))!;
    const advanced = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
    });
    expect(advanced.effect?.executed).toBe(true);
    expect(advanced.recordedPrefers).toEqual([]);
  });

  it("denies a request-only REQUIRES claim and allows only an on-disk fact", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-req-"));
    const { pack, field, agents, facts } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.REQUIRES = [REQUIRED];
        const read = unsigned.actionClassVerbs.find((v) => v.id === "read");
        if (read) read.REQUIRES = [REQUIRED];
      }),
      { computerBaseDir: dir },
    );
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
      }),
    ).toThrow(/REQUIRES missing/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        conditions: [REQUIRED],
      }),
    ).toThrow(/REQUIRES missing/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        conditions: [REQUIRED],
      }),
    ).toThrow(/fail closed/);

    const paths = computerRoot(dir, "t1");
    expect(existsSync(paths.factsFile)).toBe(false);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);

    facts.put("t1", REQUIRED);
    expect(paths.factsFile).toBe(path.join(dir, "tenants", "t1", "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(new FactBook(dir).presentIds("t1")).toEqual([REQUIRED]);

    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
    });
    const agent = agents.find((a) => a.specialties.includes("buyer"))!;
    const advanced = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
    });
    expect(advanced.effect?.executed).toBe(true);
  });

  it("fail-closes start and progress when an on-disk AVOIDS fact is present", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-avoid-"));
    const { pack, field, agents, facts } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.AVOIDS = [AVOIDED];
        const read = unsigned.actionClassVerbs.find((v) => v.id === "read");
        if (read) read.AVOIDS = [AVOIDED];
      }),
      { computerBaseDir: dir },
    );
    const open = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      conditions: [AVOIDED],
    });
    expect(open.status).toBe("open");

    facts.put("t1", AVOIDED);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
      }),
    ).toThrow(/AVOIDS present/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
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
      }),
    ).toThrow(/AVOIDS present/);
  });

  it("records PREFERS on the field path and does not fail closed when unmet", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-pref-"));
    const { pack, field, agents, store, facts } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.PREFERS = [PREFERRED];
        const read = unsigned.actionClassVerbs.find((v) => v.id === "read");
        if (read) read.PREFERS = [PREFERRED];
      }),
      { computerBaseDir: dir },
    );
    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
    });
    expect(journey.status).toBe("open");
    const agent = agents.find((a) => a.specialties.includes("buyer"))!;
    const unmet = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
    });
    expect(unmet.effect?.executed).toBe(true);
    expect(unmet.recordedPrefers).toEqual([PREFERRED]);
    expect(store.evidence.some((e) => e.kind === "journey_progress" && e.payload.recordedPrefers)).toBe(
      true,
    );

    facts.put("t1", PREFERRED);
    const met = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
      conditions: [PREFERRED],
    });
    expect(met.effect?.executed).toBe(true);
    expect(met.recordedPrefers).toEqual([PREFERRED]);
  });

  it("records and retracts a fact only after an owner_instance card is approved", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-write-"));
    const { pack, field, cards, agents, facts } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.REQUIRES = [REQUIRED];
      }),
      { computerBaseDir: dir },
    );
    const paths = computerRoot(dir, "t1");
    const write = { actor: "field" as const, pack, id: REQUIRED };

    expect(() =>
      field.record({ actor: "architect", pack, id: REQUIRED }),
    ).toThrow(SurfaceViolationError);

    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
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
    expect(facts.presentIds("t1")).toEqual([]);
    expect(() => field.commitApprovedFact(cardId)).toThrow(/approved card/);
    expect(existsSync(paths.factsFile)).toBe(false);

    cards.resolve({ cardId, decision: "approved", actor: "field" });
    const recorded = field.commitApprovedFact(cardId);
    expect(recorded).toEqual({ id: REQUIRED, present: true });
    expect(paths.factsFile).toBe(path.join(dir, "tenants", "t1", "facts.json"));
    expect(existsSync(paths.factsFile)).toBe(true);
    expect(existsSync(path.join(paths.disk, "facts.json"))).toBe(false);
    expect(new FactBook(dir).presentIds("t1")).toEqual([REQUIRED]);

    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
    });
    const agent = agents.find((a) => a.specialties.includes("buyer"))!;
    const advanced = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
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
    expect(new FactBook(dir).presentIds("t1")).toEqual([REQUIRED]);
    expect(existsSync(paths.factsFile)).toBe(true);

    cards.resolve({ cardId: retractId, decision: "approved", actor: "field" });
    expect(field.commitApprovedFact(retractId)).toEqual({ id: REQUIRED, present: false });
    expect(new FactBook(dir).presentIds("t1")).toEqual([]);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
      }),
    ).toThrow(/REQUIRES missing/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
      }),
    ).toThrow(/fail closed/);
  });

  it("keeps a denied fact write terminal and off disk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "av-facts-deny-"));
    const { pack, field, cards } = await reFieldStack(undefined, { computerBaseDir: dir });
    const paths = computerRoot(dir, "t1");
    const write = { actor: "field" as const, pack, id: REQUIRED };

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
    expect(new FactBook(dir).presentIds("t1")).toEqual([]);
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
    const { pack, field } = await reFieldStack(signed, { computerBaseDir: dir });
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
      }),
    ).toThrow(AvError);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
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
    expect(() =>
      guessedStack.field.start({
        actor: "field",
        pack: guessedStack.pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        conditions: [REQUIRED],
      }),
    ).toThrow(/corrupt/i);
  });
});
