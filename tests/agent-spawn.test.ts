import { describe, expect, it } from "vitest";
import { AgentMailer } from "../src/agents/mail.js";
import { AgentMemoryStore } from "../src/agents/memory.js";
import { loadSignedFixture } from "./helpers.js";

describe("agent spawn envelope", () => {
  it("instantiates agents from the pack org chart with no hardcoded N", async () => {
    const four = await loadSignedFixture(4);
    const twelve = await loadSignedFixture(12);
    const spawnedFour = await four.spawner.spawnFromPack({
      tenantId: four.tenantId,
      principal: four.people.architect,
      pack: four.loaded,
    });
    const spawnedTwelve = await twelve.spawner.spawnFromPack({
      tenantId: twelve.tenantId,
      principal: twelve.people.architect,
      pack: twelve.loaded,
    });
    expect(spawnedFour.agents).toHaveLength(4);
    expect(spawnedTwelve.agents).toHaveLength(12);
    expect(new Set(spawnedFour.agents.map((agent) => agent.name)).size).toBe(4);
    expect(spawnedTwelve.agents.every((agent) => agent.evalPassed)).toBe(true);
    expect(spawnedFour.agents[0]?.persona.length).toBeGreaterThan(10);
    expect(spawnedFour.agents[0]?.skills.length).toBeGreaterThan(0);
  });

  it("refuses field users who try to spawn agents", async () => {
    const ctx = await loadSignedFixture(3);
    await expect(
      ctx.spawner.spawnFromPack({
        tenantId: ctx.tenantId,
        principal: ctx.people.field,
        pack: ctx.loaded,
      }),
    ).rejects.toMatchObject({ code: "ARCHITECT_ONLY" });
  });

  it("lets agents mail each other without granting authority", async () => {
    const ctx = await loadSignedFixture(4);
    const spawned = await ctx.spawner.spawnFromPack({
      tenantId: ctx.tenantId,
      principal: ctx.people.architect,
      pack: ctx.loaded,
    });
    const mailer = new AgentMailer(ctx.agents);
    const mail = await mailer.send({
      tenantId: ctx.tenantId,
      fromAgentId: spawned.agents[0]!.id,
      toAgentId: spawned.agents[1]!.id,
      body: "Please dispatch the connector.",
    });
    expect(mail.body).toContain("dispatch");
    const decision = await ctx.gateway.evaluate({
      pack: ctx.loaded,
      effect: {
        tenantId: ctx.tenantId,
        agentId: spawned.agents[0]!.id,
        verb: "connector.dispatch",
        actionClass: "egress",
        external: true,
        claimedAuthorityFromMail: true,
      },
    });
    expect(decision.stance).toBe("deny");
    expect(decision.code).toBe("MAIL_NOT_AUTHORITY");
  });

  it("refuses memory promoted to facts", async () => {
    const ctx = await loadSignedFixture(2);
    const spawned = await ctx.spawner.spawnFromPack({
      tenantId: ctx.tenantId,
      principal: ctx.people.architect,
      pack: ctx.loaded,
    });
    const memory = new AgentMemoryStore(ctx.agents);
    await expect(
      memory.write({
        tenantId: ctx.tenantId,
        agentId: spawned.agents[0]!.id,
        tier: "semantic",
        content: "this is a fact",
        claimedAsFact: true,
      }),
    ).rejects.toMatchObject({ code: "MEMORY_NOT_FACT" });
  });
});
