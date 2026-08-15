import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/agents/runtime.js";
import { CardBook } from "../src/auth/cards.js";
import { DurableStore } from "../src/data/store.js";
import { EffectExecutor } from "../src/effects/executor.js";
import { AuthorizationRequiredError } from "../src/errors.js";
import { GrantBook } from "../src/grants/store.js";
import { MemoryPackRegistry, PackLoader } from "../src/packs/loader.js";
import { PolicyGateway } from "../src/policy/gateway.js";
import { ArchitectSurface } from "../src/surfaces/architect.js";
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
    const ask = new AskSurface();
    expect(() =>
      ask.assertAllowed(loaded.loaded, {
        tenantId: "t1",
        text: "please send this",
        actionClass: "prohibited",
      }),
    ).toThrow(/Ask ceiling/);
    expect(() =>
      ask.assertAllowed(loaded.loaded, {
        tenantId: "t1",
        text: "pick a model for me",
        actionClass: "read",
      }),
    ).toThrow(/architecture console/);
  });

  it("Architect home is not owner-auth and is not the field home", () => {
    const home = new ArchitectSurface().home();
    expect(home.grants).toBe(true);
    expect(home.packLoad).toBe(true);
    expect(home.fieldOwnerAuth).toBe(false);
  });
});
