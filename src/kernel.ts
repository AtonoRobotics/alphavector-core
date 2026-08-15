import { createHash } from "node:crypto";
import { AgentMailer } from "./agents/mail.js";
import { AgentMemoryStore } from "./agents/memory.js";
import { AgentSpawner } from "./agents/spawn.js";
import { MemoryAgentStore, type AgentStore } from "./agents/store.js";
import { ComputerHost } from "./computer/host.js";
import { ComputerUseWorker } from "./computer/worker.js";
import { egressFromPack } from "./computer/egress.js";
import { DataPlane, MemoryDataPlaneStore } from "./data/plane.js";
import { signedGenericPack, unsignedGenericPack } from "./fixtures/generic-pack.js";
import { FailClosedModelBinder, type ModelBinder } from "./model/binder.js";
import { PackLoader } from "./pack/loader.js";
import { generateEd25519KeyPair, packPayloadBytes, signBytes, type Ed25519KeyPair } from "./pack/signature.js";
import { MemoryPackStore, type PackStore } from "./pack/store.js";
import type { LoadedPack } from "./pack/types.js";
import { issueAuthorizationCard } from "./policy/authorization-card.js";
import { counselPayload, FailClosedCounselBinder, type CounselPolicyBinder } from "./policy/counsel-binder.js";
import { PolicyGateway } from "./policy/gateway.js";
import type { CounselSignedPolicyInstance } from "./policy/types.js";
import type { Principal } from "./principals/types.js";
import { PRODUCT } from "./product.js";

export interface Kernel {
  product: typeof PRODUCT;
  packLoader: PackLoader;
  spawner: AgentSpawner;
  mailer: AgentMailer;
  memory: AgentMemoryStore;
  gateway: PolicyGateway; // replaced after a counsel instance is bound
  data: DataPlane;
  computer: ComputerHost;
  worker: ComputerUseWorker;
  modelBinder: ModelBinder;
  keys: {
    pack: Ed25519KeyPair;
    owner: Ed25519KeyPair;
    counsel: Ed25519KeyPair;
    card: Ed25519KeyPair;
  };
  principals: {
    architect: Principal;
    field: Principal;
  };
  tenantId: string;
  issueFixtureCounsel(pack: LoadedPack): CounselSignedPolicyInstance;
  issueCard(verbs: string[], expiresAt: Date): ReturnType<typeof issueAuthorizationCard>;
}

export interface KernelOptions {
  tenantId?: string;
  packStore?: PackStore;
  agentStore?: AgentStore;
  modelBinder?: ModelBinder;
  counselBinder?: CounselPolicyBinder;
  computer?: ComputerHost;
}

export function createKernel(options: KernelOptions = {}): Kernel {
  const tenantId = options.tenantId ?? "tenant_demo";
  const keys = {
    pack: generateEd25519KeyPair(),
    owner: generateEd25519KeyPair(),
    counsel: generateEd25519KeyPair(),
    card: generateEd25519KeyPair(),
  };
  const architect: Principal = {
    id: "principal_architect",
    tenantId,
    kind: "architect",
    displayName: "Architect",
  };
  const field: Principal = {
    id: "principal_field",
    tenantId,
    kind: "field_user",
    displayName: "Field",
  };
  const packStore = options.packStore ?? new MemoryPackStore();
  const agentStore = options.agentStore ?? new MemoryAgentStore();
  const packLoader = new PackLoader(packStore);
  const spawner = new AgentSpawner(agentStore);
  const mailer = new AgentMailer(agentStore);
  const memory = new AgentMemoryStore(agentStore);
  const data = new DataPlane(new MemoryDataPlaneStore());
  const computer = options.computer ?? new ComputerHost();
  const worker = new ComputerUseWorker(computer);

  const issueFixtureCounsel = (pack: LoadedPack): CounselSignedPolicyInstance => {
    const instance = {
      tenantId,
      packId: pack.document.identity.packId,
      packVersion: pack.document.identity.version,
      counselId: "fixture-counsel",
      signedAt: new Date(),
      policyBodyHash: createHash("sha256").update(packPayloadBytes(pack.document)).digest("hex"),
    };
    return {
      ...instance,
      publicKey: keys.counsel.publicKey,
      signature: signBytes(keys.counsel.privateKey, counselPayload(instance)),
    };
  };

  const counselBinder = options.counselBinder ?? new FailClosedCounselBinder();

  const gateway = new PolicyGateway(counselBinder);

  return {
    product: PRODUCT,
    packLoader,
    spawner,
    mailer,
    memory,
    gateway,
    data,
    computer,
    worker,
    modelBinder: options.modelBinder ?? new FailClosedModelBinder(),
    keys,
    principals: { architect, field },
    tenantId,
    issueFixtureCounsel,
    issueCard(verbs, expiresAt) {
      return issueAuthorizationCard({
        tenantId,
        principal: architect,
        verbs,
        actionClasses: [],
        expiresAt,
        issuerKey: keys.card,
      });
    },
  };
}

export function fixturePackFor(kernel: Kernel, seatCount = 4) {
  return signedGenericPack(kernel.keys.pack, kernel.keys.owner, seatCount);
}

export function unsignedFixturePack(seatCount = 4) {
  return unsignedGenericPack(seatCount);
}
