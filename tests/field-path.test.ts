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
} from "./helpers.js";

const RE_PIN = "fc7e34e385743c7a6d0adcf9109bf5aa0c5a9230";

async function reFieldStack() {
  const { anchors, binding } = await signedRePack();
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
  it("keeps the RE fixture pin at fc7e34e", () => {
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
});
