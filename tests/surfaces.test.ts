import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agents/runtime.js";
import { CardBook } from "../src/auth/cards.js";
import { DurableStore } from "../src/data/store.js";
import { EffectExecutor } from "../src/effects/executor.js";
import { AuthorizationRequiredError } from "../src/errors.js";
import { GrantBook } from "../src/grants/store.js";
import { DryStemAdapter } from "../src/habitat/adapter.js";
import { AlphaVectorCore } from "../src/kernel.js";
import { MemoryPackRegistry, PackLoader } from "../src/packs/loader.js";
import { PolicyGateway } from "../src/policy/gateway.js";
import { AskSurface } from "../src/surfaces/ask.js";
import { FieldSurface } from "../src/surfaces/field.js";
import { signedGenericPack } from "./helpers.js";

describe("three surfaces DEC-024", () => {
  it("field home has journeys, inbox, outbound log, kill switch, and no Architect controls", async () => {
    const { anchors, binding } = await signedGenericPack();
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const loaded = loader.load({ tenantId: "t1", binding, actor: "architect" });
    if (!loaded.ok) throw new Error(loaded.message);
    const store = new DurableStore();
    const cards = new CardBook();
    const grants = new GrantBook();
    store.createJourney("t1", "inquiry", "Answer the inbound question");
    const runtime = new AgentRuntime();
    const agents = runtime.instantiateFromPack(loaded.loaded, "architect");
    const writer = agents.find((a) => a.name === "Writer")!;
    const effects = new EffectExecutor(new PolicyGateway(), grants, cards, store);
    try {
      effects.execute({
        pack: loaded.loaded,
        agent: writer,
        actionClass: "communicate",
        channel: "email",
        purpose: "follow-up",
        subject: "case",
        surface: "field",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationRequiredError);
    }
    const field = new FieldSurface(cards, store, grants);
    const home = field.home("t1");
    expect(home.journeys).toHaveLength(1);
    expect(home.inbox).toHaveLength(1);
    expect(home.killSwitch.available).toBe(true);
    expect(home.architectControls).toEqual([]);
    field.assertFieldSafe("Send this follow-up");
    expect(() => field.assertFieldSafe("open the trust ladder")).toThrow(/must not expose/);
  });

  it("Ask cannot exceed pack ceilings or become an architecture console", async () => {
    const { anchors, binding } = await signedGenericPack();
    const loader = new PackLoader(new MemoryPackRegistry(), anchors);
    const loaded = loader.load({ tenantId: "t1", binding, actor: "architect" });
    if (!loaded.ok) throw new Error(loaded.message);
    const store = new DurableStore();
    const ask = new AskSurface(store);
    const ceiling = {
      tenantId: "t1",
      text: "please send this",
      actionClass: "prohibited",
    };
    const consoleReq = {
      tenantId: "t1",
      text: "pick a model for me",
      actionClass: "read",
    };
    expect(() => ask.assertAllowed(loaded.loaded, ceiling)).toThrow(/Ask ceiling/);
    expect(() => ask.assertAllowed(loaded.loaded, ceiling)).toThrow(/Ask ceiling/);
    expect(() => ask.assertAllowed(loaded.loaded, consoleReq)).toThrow(/architecture console/);
    expect(() => ask.assertAllowed(loaded.loaded, consoleReq)).toThrow(/architecture console/);
    const again = new AskSurface(store);
    expect(() => again.assertAllowed(loaded.loaded, consoleReq)).toThrow(/architecture console/);
    expect(() => again.assertAllowed(loaded.loaded, ceiling)).toThrow(/Ask ceiling/);
  });

  it("Architect home is the habitat seat, not five booleans and not the field home", async () => {
    const computerBaseDir = await mkdtemp(path.join(os.tmpdir(), "av-architect-home-"));
    const { anchors, binding } = await signedGenericPack();
    const core = new AlphaVectorCore(anchors, path.join(computerBaseDir, "state"), computerBaseDir, {
      adapter: new DryStemAdapter(),
    });
    const loaded = core.packs.load({ tenantId: "t1", binding, actor: "architect" });
    if (!loaded.ok) throw new Error(loaded.message);
    core.agents.instantiateFromPack(loaded.loaded, "architect");
    const home = core.architect.home("t1");
    const sit = core.architect.sit("t1");
    expect(home).toEqual(sit);
    expect(Array.isArray(home.org)).toBe(true);
    expect(home.org.length).toBeGreaterThan(0);
    expect(home.org.every((a) => a.agentId && a.name)).toBe(true);
    expect(Array.isArray(home.runs)).toBe(true);
    expect(Array.isArray(home.workers)).toBe(true);
    expect(Array.isArray(home.grants)).toBe(true);
    expect(Array.isArray(home.eval.fixtures)).toBe(true);
    expect(home.eval.fixtures.length).toBeGreaterThan(0);
    expect(home.isolation.isolation).toBe("trailer");
    expect(home).not.toEqual({
      grants: true,
      packLoad: true,
      evaluation: true,
      connectors: true,
      fieldOwnerAuth: false,
    });
    expect(home).not.toHaveProperty("architectControls");
    expect(home).not.toHaveProperty("fieldOwnerAuth");
    const field = new FieldSurface(core.cards, core.store, core.grants);
    expect(field.home("t1").architectControls).toEqual([]);
  });
});
