import { describe, expect, it } from "vitest";
import { FailClosedCounselBinder } from "../src/policy/counsel-binder.js";
import { PolicyGateway } from "../src/policy/gateway.js";
import { issueAuthorizationCard } from "../src/policy/authorization-card.js";
import { loadSignedFixture } from "./helpers.js";

describe("policy gateway", () => {
  it("fails closed without a counsel-signed policy instance", async () => {
    const ctx = await loadSignedFixture(2);
    const spawned = await ctx.spawner.spawnFromPack({
      tenantId: ctx.tenantId,
      principal: ctx.people.architect,
      pack: ctx.loaded,
    });
    const gateway = new PolicyGateway(new FailClosedCounselBinder());
    await expect(
      gateway.evaluate({
        pack: ctx.loaded,
        effect: {
          tenantId: ctx.tenantId,
          agentId: spawned.agents[0]!.id,
          verb: "record.write",
          actionClass: "mutate",
          external: true,
        },
      }),
    ).rejects.toMatchObject({ code: "POLICY_BINDER_MISSING" });
  });

  it("keeps authorization as the default for external effects", async () => {
    const ctx = await loadSignedFixture(2);
    const spawned = await ctx.spawner.spawnFromPack({
      tenantId: ctx.tenantId,
      principal: ctx.people.architect,
      pack: ctx.loaded,
    });
    const decision = await ctx.gateway.evaluate({
      pack: ctx.loaded,
      effect: {
        tenantId: ctx.tenantId,
        agentId: spawned.agents[0]!.id,
        verb: "record.write",
        actionClass: "mutate",
        external: true,
      },
    });
    expect(decision.stance).toBe("require_authorization");
    expect(decision.policyStillApplies).toBe(true);
    expect(decision.code).toBe("AUTHORIZATION_DEFAULT");
  });

  it("allows an external effect only with a valid authorization card", async () => {
    const ctx = await loadSignedFixture(2);
    const spawned = await ctx.spawner.spawnFromPack({
      tenantId: ctx.tenantId,
      principal: ctx.people.architect,
      pack: ctx.loaded,
    });
    const card = issueAuthorizationCard({
      tenantId: ctx.tenantId,
      principal: ctx.people.architect,
      verbs: ["record.write"],
      actionClasses: ["mutate"],
      expiresAt: new Date(Date.now() + 60_000),
      issuerKey: ctx.keys.pack,
    });
    const denied = await ctx.gateway.evaluate({
      pack: ctx.loaded,
      effect: {
        tenantId: ctx.tenantId,
        agentId: spawned.agents[0]!.id,
        verb: "record.write",
        actionClass: "mutate",
        external: true,
      },
    });
    expect(denied.stance).not.toBe("allow");
    const allowed = await ctx.gateway.evaluate({
      pack: ctx.loaded,
      effect: {
        tenantId: ctx.tenantId,
        agentId: spawned.agents[0]!.id,
        verb: "record.write",
        actionClass: "mutate",
        external: true,
      },
      card,
      cardIssuerPublicKey: ctx.keys.pack.publicKey,
    });
    expect(allowed.stance).toBe("allow");
    expect(allowed.cardId).toBe(card.id);
    expect(allowed.policyStillApplies).toBe(true);
  });

  it("denies assumed routine autonomy (EXC-008)", async () => {
    const ctx = await loadSignedFixture(2);
    const spawned = await ctx.spawner.spawnFromPack({
      tenantId: ctx.tenantId,
      principal: ctx.people.architect,
      pack: ctx.loaded,
    });
    const decision = await ctx.gateway.evaluate({
      pack: ctx.loaded,
      effect: {
        tenantId: ctx.tenantId,
        agentId: spawned.agents[0]!.id,
        verb: "schedule.create",
        actionClass: "excluded_assumed_autonomy",
        external: true,
        assumedRoutineAutonomy: true,
      },
    });
    expect(decision.stance).toBe("deny");
    expect(decision.code).toBe("EXC_008");
  });

  it("treats surprise self-evaluation as a product failure", async () => {
    const ctx = await loadSignedFixture(2);
    const spawned = await ctx.spawner.spawnFromPack({
      tenantId: ctx.tenantId,
      principal: ctx.people.architect,
      pack: ctx.loaded,
    });
    const actor = spawned.agents[0]!;
    const decision = await ctx.gateway.evaluate({
      pack: ctx.loaded,
      effect: {
        tenantId: ctx.tenantId,
        agentId: actor.id,
        verb: "record.write",
        actionClass: "mutate",
        external: true,
      },
      evidence: {
        id: "ev1",
        tenantId: ctx.tenantId,
        verb: "record.write",
        actorAgentId: actor.id,
        evaluatorId: actor.id,
        summary: "I checked myself",
        createdAt: new Date(),
      },
    });
    expect(decision.stance).toBe("deny");
    expect(decision.code).toBe("SURPRISE_GRADUATION");
  });

  it("does not strip policy after independent outcome evidence", async () => {
    const ctx = await loadSignedFixture(2);
    const spawned = await ctx.spawner.spawnFromPack({
      tenantId: ctx.tenantId,
      principal: ctx.people.architect,
      pack: ctx.loaded,
    });
    const actor = spawned.agents[0]!;
    const reviewer = spawned.agents[1]!;
    const decision = await ctx.gateway.evaluate({
      pack: ctx.loaded,
      effect: {
        tenantId: ctx.tenantId,
        agentId: actor.id,
        verb: "record.write",
        actionClass: "mutate",
        external: true,
      },
      evidence: {
        id: "ev2",
        tenantId: ctx.tenantId,
        verb: "record.write",
        actorAgentId: actor.id,
        evaluatorId: reviewer.id,
        summary: "Independent reviewer observed the authorized write matched the packet.",
        createdAt: new Date(),
      },
    });
    expect(decision.stance).toBe("allow");
    expect(decision.policyStillApplies).toBe(true);
    expect(decision.code).toBe("GRADUATED_WITH_POLICY");
  });
});
