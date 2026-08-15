import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agents/runtime.js";
import { CardBook } from "../src/auth/cards.js";
import { DurableStore } from "../src/data/store.js";
import { CORE_SCHEMA_SQL } from "../src/data/sql.js";
import { EffectExecutor } from "../src/effects/executor.js";
import { AuthorizationRequiredError, PolicyDeniedError, SurfaceViolationError } from "../src/errors.js";
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

async function reFieldStack(signed?: Awaited<ReturnType<typeof signedRePack>>) {
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
  const field = new FieldSurface(cards, store, grants, journeys, effects, ask);
  const agents = new AgentRuntime().instantiateFromPack(loaded.loaded, "architect");
  return { pack: loaded.loaded, field, cards, store, grants, agents, ask };
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

  it("fail-closes start and progress when a declared REQUIRES is missing", async () => {
    const { pack, field, agents } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.REQUIRES = [REQUIRED];
        const read = unsigned.actionClassVerbs.find((v) => v.id === "read");
        if (read) read.REQUIRES = [REQUIRED];
      }),
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
      }),
    ).toThrow(/fail closed/);

    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
      conditions: [REQUIRED],
    });
    const agent = agents.find((a) => a.specialties.includes("buyer"))!;
    expect(() =>
      field.progress({
        actor: "field",
        pack,
        journeyId: journey.id,
        agent,
        actionClass: "read",
      }),
    ).toThrow(/REQUIRES missing/);
    const advanced = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
      conditions: [REQUIRED],
    });
    expect(advanced.effect?.executed).toBe(true);
  });

  it("fail-closes start and progress when a declared AVOIDS is present", async () => {
    const { pack, field, agents } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.AVOIDS = [AVOIDED];
        const read = unsigned.actionClassVerbs.find((v) => v.id === "read");
        if (read) read.AVOIDS = [AVOIDED];
      }),
    );
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        conditions: [AVOIDED],
      }),
    ).toThrow(/AVOIDS present/);
    expect(() =>
      field.start({
        actor: "field",
        pack,
        journeyKind: "buyer",
        objective: "Work this buyer journey",
        conditions: [AVOIDED],
      }),
    ).toThrow(/fail closed/);

    const journey = field.start({
      actor: "field",
      pack,
      journeyKind: "buyer",
      objective: "Work this buyer journey",
    });
    const agent = agents.find((a) => a.specialties.includes("buyer"))!;
    expect(() =>
      field.progress({
        actor: "field",
        pack,
        journeyId: journey.id,
        agent,
        actionClass: "read",
        conditions: [AVOIDED],
      }),
    ).toThrow(/AVOIDS present/);
    const advanced = field.progress({
      actor: "field",
      pack,
      journeyId: journey.id,
      agent,
      actionClass: "read",
    });
    expect(advanced.effect?.executed).toBe(true);
  });

  it("records PREFERS on the field path and does not fail closed when unmet", async () => {
    const { pack, field, agents, store } = await reFieldStack(
      await signedRePackMutated((unsigned) => {
        const buyer = unsigned.journeyKinds.find((k) => k.id === "buyer");
        if (buyer) buyer.PREFERS = [PREFERRED];
        const read = unsigned.actionClassVerbs.find((v) => v.id === "read");
        if (read) read.PREFERS = [PREFERRED];
      }),
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
});
