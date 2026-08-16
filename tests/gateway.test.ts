import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agents/runtime.js";
import { CardBook } from "../src/auth/cards.js";
import { DurableStore } from "../src/data/store.js";
import { EffectExecutor } from "../src/effects/executor.js";
import { AuthorizationRequiredError, AvError, PolicyDeniedError } from "../src/errors.js";
import { assertHabitatMayAsk, habitatAskReason } from "../src/grants/ask.js";
import { GrantBook } from "../src/grants/store.js";
import { MemoryPackRegistry, PackLoader } from "../src/packs/loader.js";
import { PolicyGateway } from "../src/policy/gateway.js";
import { signedGenericPack } from "./helpers.js";

async function setup() {
  const { anchors, binding } = await signedGenericPack();
  const loader = new PackLoader(new MemoryPackRegistry(), anchors);
  const loaded = loader.load({ tenantId: "t1", binding, actor: "architect" });
  if (!loaded.ok) throw new Error(loaded.message);
  const runtime = new AgentRuntime();
  const agents = runtime.instantiateFromPack(loaded.loaded, "architect");
  const writer = agents.find((a) => a.name === "Writer")!;
  const grants = new GrantBook();
  const cards = new CardBook();
  const store = new DurableStore();
  const gateway = new PolicyGateway();
  const effects = new EffectExecutor(gateway, grants, cards, store);
  return { pack: loaded.loaded, writer, grants, cards, store, gateway, effects };
}

describe("policy gateway + auth cards", () => {
  it("denies DNC even if someone wants to send", async () => {
    const { pack, writer, effects } = await setup();
    expect(() =>
      effects.execute({
        pack,
        agent: writer,
        actionClass: "communicate",
        channel: "email",
        purpose: "dnc",
        subject: "case",
        surface: "field",
      }),
    ).toThrow(PolicyDeniedError);
  });

  it("issues an owner-auth card when authorization is the default", async () => {
    const { pack, writer, effects, cards } = await setup();
    try {
      effects.execute({
        pack,
        agent: writer,
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "case",
        surface: "field",
      });
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
      const cardId = (err as AuthorizationRequiredError).cardId;
      const view = cards.fieldInbox("t1");
      expect(view).toHaveLength(1);
      expect(view[0]!.cardId).toBe(cardId);
      expect(view[0]!.purpose).toBe("Send this follow-up");
      expect(JSON.stringify(view[0]!)).not.toMatch(/T0|T1|T2|T3|trust/i);
    }
  });

  it("executes after field approve, and deny is terminal", async () => {
    const { pack, writer, effects, cards, store } = await setup();
    let cardId = "";
    try {
      effects.execute({
        pack,
        agent: writer,
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "case",
        surface: "field",
      });
    } catch (err) {
      cardId = (err as AuthorizationRequiredError).cardId;
    }
    cards.resolve({ cardId, decision: "approved", actor: "field-user" });
    const result = effects.execute({
      pack,
      agent: writer,
      actionClass: "communicate",
      channel: "email",
      purpose: "follow-up",
      subject: "case",
      surface: "field",
      approvedCardId: cardId,
    });
    expect(result.executed).toBe(true);
    expect(store.actions.some((a) => a.status === "executed")).toBe(true);

    const { pack: pack2, writer: writer2, effects: effects2, cards: cards2 } = await setup();
    let denyId = "";
    try {
      effects2.execute({
        pack: pack2,
        agent: writer2,
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "case",
        surface: "field",
      });
    } catch (err) {
      denyId = (err as AuthorizationRequiredError).cardId;
    }
    cards2.resolve({ cardId: denyId, decision: "denied", actor: "field-user" });
    expect(() =>
      effects2.execute({
        pack: pack2,
        agent: writer2,
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "case",
        surface: "field",
      }),
    ).toThrow(/terminal/);
  });

  it("graduation cannot strip the policy gateway", async () => {
    const { pack, writer, effects, grants } = await setup();
    grants.write({
      actor: "architect",
      tenantId: "t1",
      agentId: writer.agentId,
      actionClass: "communicate",
      state: "authorized",
      bounds: { channels: ["email"] },
      owner: "architect-1",
      evidenceIds: ["ev1"],
      evalIds: ["eval1"],
      fieldNotice: "Follow-up emails will now send without asking. You can kill this.",
    });
    expect(() =>
      effects.execute({
        pack,
        agent: writer,
        actionClass: "communicate",
        channel: "email",
        purpose: "dnc",
        subject: "case",
        surface: "field",
      }),
    ).toThrow(PolicyDeniedError);
  });

  it("surprise graduation without notice is a product failure", async () => {
    const { writer, grants } = await setup();
    expect(() =>
      grants.write({
        actor: "architect",
        tenantId: "t1",
        agentId: writer.agentId,
        actionClass: "communicate",
        state: "authorized",
        bounds: {},
        owner: "architect-1",
        evidenceIds: [],
        evalIds: [],
      }),
    ).toThrow(/Surprise graduation/);
  });

  it("refuses mail as an authority source", async () => {
    const { pack, writer, effects } = await setup();
    expect(() =>
      effects.execute({
        pack,
        agent: writer,
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "case",
        surface: "field",
        claimedAuthorityFromMail: true,
      }),
    ).toThrow(/Mail does not confer authority/);
  });

  it("refuses assumed routine autonomy (EXC-008)", async () => {
    const { pack, writer, effects } = await setup();
    expect(() =>
      effects.execute({
        pack,
        agent: writer,
        actionClass: "communicate",
        channel: "email",
        purpose: "recovery",
        subject: "case",
        surface: "field",
        assumedRoutineAutonomy: true,
      }),
    ).toThrow(/EXC-008/);
  });

  it("notice without independent evidence is surprise graduation", async () => {
    const { writer, grants } = await setup();
    expect(() =>
      grants.write({
        actor: "architect",
        tenantId: "t1",
        agentId: writer.agentId,
        actionClass: "communicate",
        state: "authorized",
        bounds: {},
        owner: "architect-1",
        evidenceIds: [],
        evalIds: [],
        fieldNotice: "Emails will send without asking.",
      }),
    ).toThrow(/independent outcome evidence/);
  });

  it("field cannot write grants", async () => {
    const { writer, grants } = await setup();
    expect(() =>
      grants.write({
        actor: "field",
        tenantId: "t1",
        agentId: writer.agentId,
        actionClass: "communicate",
        state: "authorized",
        bounds: {},
        owner: "field",
        evidenceIds: [],
        evalIds: [],
        fieldNotice: "nope",
      }),
    ).toThrow(/cannot create, widen, or graduate/);
  });

  it("uses an authorized grant for that class even when the acting agent differs", async () => {
    const { pack, writer, effects, grants, cards, store } = await setup();
    grants.write({
      actor: "architect",
      tenantId: "t1",
      agentId: writer.agentId,
      actionClass: "communicate",
      state: "authorized",
      bounds: { channels: ["email"] },
      owner: "architect-1",
      evidenceIds: ["ev1"],
      evalIds: ["eval1"],
      fieldNotice: "Follow-up emails will now send without asking. You can kill this.",
    });
    const coder = { ...writer, agentId: "worker_not_the_grant_agent", name: "coder" };
    const before = cards.fieldInbox("t1").length;
    const result = effects.execute({
      pack,
      agent: coder,
      actionClass: "communicate",
      channel: "email",
      purpose: "follow-up",
      subject: "case",
      surface: "field",
    });
    expect(result.executed).toBe(true);
    expect(result.policyDecision).toMatch(/Email permitted|Consented follow-up/);
    expect(cards.fieldInbox("t1")).toHaveLength(before);
    expect(store.actions.some((a) => a.status === "executed")).toBe(true);
    expect(habitatAskReason({ grants, tenantId: "t1", actionClass: "communicate" })).toBeUndefined();
    expect(() => assertHabitatMayAsk(undefined)).toThrow(AvError);
    expect(() => assertHabitatMayAsk(undefined)).toThrow(/HABITAT_REASK|habitat bug/);
  });

  it("does not send or retry when there is no grant and no current card (EXC-008)", async () => {
    const { pack, writer, effects, grants, cards, store } = await setup();
    expect(grants.classState("t1", "communicate")).toBe("requires_authorization");
    expect(() =>
      effects.execute({
        pack,
        agent: writer,
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "case",
        surface: "field",
        assumedRoutineAutonomy: true,
      }),
    ).toThrow(/EXC-008/);
    expect(store.actions.some((a) => a.status === "executed")).toBe(false);

    try {
      effects.execute({
        pack,
        agent: writer,
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "case",
        surface: "field",
      });
      throw new Error("should have required a card");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
    }
    expect(store.actions.some((a) => a.status === "executed")).toBe(false);
    expect(cards.fieldInbox("t1")).toHaveLength(1);
    expect(habitatAskReason({ grants, tenantId: "t1", actionClass: "communicate" })).toBe("no_grant");
  });
});
