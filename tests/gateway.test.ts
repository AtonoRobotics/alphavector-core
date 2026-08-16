import { readFileSync } from "node:fs";
import path from "node:path";
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
import { ALPHAVECTOR_RE_PIN_SHA, signedGenericPack } from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";

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

describe("GrantBounds are enforced on the grant path (H1)", () => {
  const notice = "Follow-up emails will now send without asking. You can kill this.";

  async function graduate(
    bounds: { channels?: string[]; purposes?: string[]; ratePerHour?: number; subjectScope?: string[] },
  ) {
    const ctx = await setup();
    ctx.grants.write({
      actor: "architect",
      tenantId: "t1",
      agentId: ctx.writer.agentId,
      actionClass: "communicate",
      state: "authorized",
      bounds,
      owner: "architect-1",
      evidenceIds: ["ev1"],
      evalIds: ["eval1"],
      fieldNotice: notice,
    });
    return ctx;
  }

  function communicate(
    ctx: Awaited<ReturnType<typeof setup>>,
    extra: { channel?: string; purpose?: string; subject?: string } = {},
  ) {
    return ctx.effects.execute({
      pack: ctx.pack,
      agent: ctx.writer,
      actionClass: "communicate",
      channel: extra.channel ?? "email",
      purpose: extra.purpose ?? "follow-up",
      subject: extra.subject ?? "case",
      surface: "field",
    });
  }

  it("keeps the RE fixture pin at 5091328 and does not invent T0–T3", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
    const types = readFileSync(path.join(process.cwd(), "src/grants/types.ts"), "utf8");
    expect(types).toMatch(/export interface GrantBounds/);
    expect(types).toMatch(/T0-T3 are not accepted/);
    for (const rel of ["src/grants/store.ts", "src/grants/ask.ts", "src/effects/executor.ts"]) {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(src).not.toMatch(/\bT0\b|\bT1\b|\bT2\b|\bT3\b/);
      expect(src).not.toMatch(/api\.openai\.com|api\.anthropic\.com/);
    }
  });

  it("in-bound use of a class grant still executes without a second card", async () => {
    const ctx = await graduate({ channels: ["email"], purposes: ["follow-up"], subjectScope: ["case"] });
    const before = ctx.cards.fieldInbox("t1").length;
    expect(ctx.grants.classState("t1", "communicate")).toBe("authorized");
    expect(
      ctx.grants.classState("t1", "communicate", {
        channel: "email",
        purpose: "follow-up",
        subject: "case",
      }),
    ).toBe("authorized");
    const result = communicate(ctx);
    expect(result.executed).toBe(true);
    expect(ctx.cards.fieldInbox("t1")).toHaveLength(before);
    expect(ctx.store.actions.filter((a) => a.status === "executed")).toHaveLength(1);
    expect(habitatAskReason({
      grants: ctx.grants,
      tenantId: "t1",
      actionClass: "communicate",
      channel: "email",
      purpose: "follow-up",
      subject: "case",
    })).toBeUndefined();
  });

  it("out-of-bound channel is GRANT_BOUNDS, not a silent yes", async () => {
    const ctx = await graduate({ channels: ["email"], purposes: ["follow-up"] });
    expect(
      ctx.grants.classState("t1", "communicate", { channel: "sms", purpose: "follow-up", subject: "case" }),
    ).toBe("requires_authorization");
    expect(ctx.grants.authorizedForClass("t1", "communicate", { channel: "sms", purpose: "follow-up" })).toBeUndefined();
    try {
      communicate(ctx, { channel: "sms" });
      throw new Error("should have failed closed");
    } catch (err) {
      expect(err).toBeInstanceOf(AvError);
      expect((err as AvError).code).toBe("GRANT_BOUNDS");
      expect((err as AvError).closed).toBe(true);
      expect((err as AvError).message).toMatch(/channel/i);
    }
    expect(ctx.store.actions.some((a) => a.status === "executed")).toBe(false);
    expect(ctx.cards.fieldInbox("t1")).toHaveLength(0);
  });

  it("out-of-bound purpose is GRANT_BOUNDS, not a silent yes", async () => {
    const ctx = await graduate({ channels: ["email"], purposes: ["follow-up"] });
    try {
      communicate(ctx, { purpose: "newsletter" });
      throw new Error("should have failed closed");
    } catch (err) {
      expect(err).toBeInstanceOf(AvError);
      expect((err as AvError).code).toBe("GRANT_BOUNDS");
      expect((err as AvError).message).toMatch(/purpose/i);
    }
    expect(ctx.store.actions.some((a) => a.status === "executed")).toBe(false);
  });

  it("subject outside subjectScope is GRANT_BOUNDS, not a silent yes", async () => {
    const ctx = await graduate({
      channels: ["email"],
      purposes: ["follow-up"],
      subjectScope: ["case"],
    });
    try {
      communicate(ctx, { subject: "other-case" });
      throw new Error("should have failed closed");
    } catch (err) {
      expect(err).toBeInstanceOf(AvError);
      expect((err as AvError).code).toBe("GRANT_BOUNDS");
      expect((err as AvError).message).toMatch(/subject/i);
    }
    expect(ctx.store.actions.some((a) => a.status === "executed")).toBe(false);
    const inbound = communicate(ctx, { subject: "case" });
    expect(inbound.executed).toBe(true);
  });

  it("ratePerHour is enforced from the action log; a set rate is not ignored", async () => {
    const ctx = await graduate({
      channels: ["email"],
      purposes: ["follow-up"],
      ratePerHour: 1,
    });
    expect(
      ctx.grants.classState("t1", "communicate", {
        channel: "email",
        purpose: "follow-up",
      }),
    ).toBe("requires_authorization");
    expect(
      ctx.grants.classState("t1", "communicate", {
        channel: "email",
        purpose: "follow-up",
        executedInLastHour: 0,
      }),
    ).toBe("authorized");
    const first = communicate(ctx);
    expect(first.executed).toBe(true);
    try {
      communicate(ctx);
      throw new Error("should have failed closed on rate");
    } catch (err) {
      expect(err).toBeInstanceOf(AvError);
      expect((err as AvError).code).toBe("GRANT_RATE");
      expect((err as AvError).closed).toBe(true);
    }
    expect(ctx.store.actions.filter((a) => a.status === "executed")).toHaveLength(1);
    expect(ctx.cards.fieldInbox("t1")).toHaveLength(0);
  });

  it("graduation still cannot strip the policy gateway", async () => {
    const ctx = await graduate({ channels: ["email"], purposes: ["follow-up"] });
    expect(() => communicate(ctx, { purpose: "dnc" })).toThrow(PolicyDeniedError);
    expect(ctx.store.actions.some((a) => a.status === "executed")).toBe(false);
  });
});
