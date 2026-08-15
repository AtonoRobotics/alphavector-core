import { createHash } from "node:crypto";
import { AgentSpawner } from "../src/agents/spawn.js";
import { MemoryAgentStore } from "../src/agents/store.js";
import { signedGenericPack, unsignedGenericPack } from "../src/fixtures/generic-pack.js";
import { createKernel } from "../src/kernel.js";
import { PackLoader } from "../src/pack/loader.js";
import { generateEd25519KeyPair, packPayloadBytes, signBytes } from "../src/pack/signature.js";
import { MemoryPackStore } from "../src/pack/store.js";
import type { LoadedPack } from "../src/pack/types.js";
import { counselPayload, StaticCounselBinder } from "../src/policy/counsel-binder.js";
import { PolicyGateway } from "../src/policy/gateway.js";
import type { Principal } from "../src/principals/types.js";

export function principals(tenantId: string): { architect: Principal; field: Principal } {
  return {
    architect: { id: "arch", tenantId, kind: "architect", displayName: "Architect" },
    field: { id: "field", tenantId, kind: "field_user", displayName: "Field" },
  };
}

export async function loadSignedFixture(seatCount = 4) {
  const tenantId = `tenant_${seatCount}_${Math.random().toString(16).slice(2)}`;
  const keys = {
    pack: generateEd25519KeyPair(),
    owner: generateEd25519KeyPair(),
    counsel: generateEd25519KeyPair(),
  };
  const people = principals(tenantId);
  const store = new MemoryPackStore();
  const loader = new PackLoader(store);
  const document = signedGenericPack(keys.pack, keys.owner, seatCount);
  const loaded = await loader.load({ tenantId, principal: people.architect, document });
  const counsel = {
    tenantId,
    packId: loaded.document.identity.packId,
    packVersion: loaded.document.identity.version,
    counselId: "fixture-counsel",
    signedAt: new Date(),
    policyBodyHash: createHash("sha256").update(packPayloadBytes(loaded.document)).digest("hex"),
  };
  const instance = {
    ...counsel,
    publicKey: keys.counsel.publicKey,
    signature: signBytes(keys.counsel.privateKey, counselPayload(counsel)),
  };
  const gateway = new PolicyGateway(new StaticCounselBinder(instance));
  const agents = new MemoryAgentStore();
  const spawner = new AgentSpawner(agents);
  return { tenantId, keys, people, loader, loaded, gateway, spawner, agents, document };
}

export function unsignedPack(seatCount = 4) {
  return unsignedGenericPack(seatCount);
}

export { createKernel, signedGenericPack };
