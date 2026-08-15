import { AgentMail } from "./agents/mail.js";
import { MemoryTiers } from "./agents/memory.js";
import { Orchestrator } from "./agents/orchestrator.js";
import { AgentRuntime } from "./agents/runtime.js";
import { CardBook } from "./auth/cards.js";
import { ComputerHost, type ComputerHostOptions } from "./computer/host.js";
import { ComputerUseWorker } from "./computer/worker.js";
import { ConnectorBook } from "./connectors/primitive.js";
import { DurableStore } from "./data/store.js";
import { EffectExecutor } from "./effects/executor.js";
import { EvalRunner } from "./eval/runner.js";
import { GrantBook } from "./grants/store.js";
import { JourneyRuntime } from "./journeys/runtime.js";
import { MemoryPackRegistry, PackLoader } from "./packs/loader.js";
import type { TrustAnchors } from "./packs/signing.js";
import { PolicyGateway } from "./policy/gateway.js";
import { ArchitectSurface } from "./surfaces/architect.js";
import { AskSurface } from "./surfaces/ask.js";
import { FieldSurface } from "./surfaces/field.js";

export interface KernelOptions {
  computer: ComputerHostOptions;
  anchors: TrustAnchors;
}

export class AlphaVectorCore {
  readonly packs: PackLoader;
  readonly agents = new AgentRuntime();
  readonly mail = new AgentMail();
  readonly memory = new MemoryTiers();
  readonly orchestrator = new Orchestrator();
  readonly grants = new GrantBook();
  readonly cards = new CardBook();
  readonly store = new DurableStore();
  readonly gateway = new PolicyGateway();
  readonly effects: EffectExecutor;
  readonly field: FieldSurface;
  readonly ask = new AskSurface();
  readonly architect = new ArchitectSurface();
  readonly journeys: JourneyRuntime;
  readonly eval = new EvalRunner();
  readonly connectors = new ConnectorBook();
  computer!: ComputerHost;
  worker!: ComputerUseWorker;

  constructor(anchors: TrustAnchors) {
    this.packs = new PackLoader(new MemoryPackRegistry(), anchors);
    this.effects = new EffectExecutor(this.gateway, this.grants, this.cards, this.store);
    this.field = new FieldSurface(this.cards, this.store, this.grants);
    this.journeys = new JourneyRuntime(this.store);
  }

  static async boot(opts: KernelOptions): Promise<AlphaVectorCore> {
    const core = new AlphaVectorCore(opts.anchors);
    core.computer = await ComputerHost.create(opts.computer);
    core.worker = new ComputerUseWorker(core.computer);
    return core;
  }
}
