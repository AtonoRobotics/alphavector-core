import { AgentMail } from "./agents/mail.js";
import { MemoryTiers } from "./agents/memory.js";
import { Orchestrator } from "./agents/orchestrator.js";
import { AgentRuntime } from "./agents/runtime.js";
import { DeepAgentsAdapter } from "./habitat/deep-agents.js";
import { HabitatKernel } from "./habitat/kernel.js";
import type { CognitiveAdapter } from "./habitat/types.js";
import { CardBook } from "./auth/cards.js";
import { FieldTokenBook } from "./auth/field-tokens.js";
import { ComputerHost, type ComputerHostOptions } from "./computer/host.js";
import { ConnectorBook } from "./connectors/primitive.js";
import { DurableStore } from "./data/store.js";
import { EffectExecutor } from "./effects/executor.js";
import { EvalRunner } from "./eval/runner.js";
import { FactBook } from "./facts/book.js";
import { GrantBook } from "./grants/store.js";
import { RecordBook } from "./records/book.js";
import { JourneyRuntime } from "./journeys/runtime.js";
import path from "node:path";
import { FilePackRegistry } from "./packs/file-registry.js";
import { MemoryPackRegistry, PackLoader } from "./packs/loader.js";
import type { TrustAnchors } from "./packs/signing.js";
import { PolicyGateway } from "./policy/gateway.js";
import { ArchitectSurface } from "./surfaces/architect.js";
import { AskSurface } from "./surfaces/ask.js";
import { FieldSurface } from "./surfaces/field.js";

export interface KernelOptions {
  computer: ComputerHostOptions;
  anchors: TrustAnchors;
  stateDir?: string;
}

export class AlphaVectorCore {
  readonly packs: PackLoader;
  readonly agents: AgentRuntime;
  readonly mail = new AgentMail();
  readonly memory = new MemoryTiers();
  readonly orchestrator = new Orchestrator();
  readonly habitat: HabitatKernel;
  readonly grants: GrantBook;
  readonly cards: CardBook;
  readonly fieldTokens: FieldTokenBook;
  readonly facts: FactBook;
  readonly records: RecordBook;
  readonly store = new DurableStore();
  readonly gateway = new PolicyGateway();
  readonly effects: EffectExecutor;
  readonly field: FieldSurface;
  readonly ask: AskSurface;
  readonly architect: ArchitectSurface;
  readonly journeys: JourneyRuntime;
  readonly eval = new EvalRunner();
  readonly connectors = new ConnectorBook();
  computer!: ComputerHost;

  constructor(
    anchors: TrustAnchors,
    stateDir?: string,
    computerBaseDir?: string,
    opts?: { adapter?: CognitiveAdapter; now?: () => string; tickMs?: number },
  ) {
    this.packs = new PackLoader(
      stateDir ? new FilePackRegistry(stateDir) : new MemoryPackRegistry(),
      anchors,
    );
    this.agents = new AgentRuntime(stateDir);
    this.grants = new GrantBook(computerBaseDir);
    this.cards = new CardBook(computerBaseDir);
    this.fieldTokens = new FieldTokenBook(computerBaseDir);
    this.facts = new FactBook(computerBaseDir);
    this.records = new RecordBook(computerBaseDir);
    this.effects = new EffectExecutor(this.gateway, this.grants, this.cards, this.store);
    this.journeys = new JourneyRuntime(this.store);
    this.ask = new AskSurface(this.store);
    this.field = new FieldSurface(
      this.cards,
      this.store,
      this.grants,
      this.journeys,
      this.effects,
      this.ask,
      this.facts,
      this.records,
      computerBaseDir,
    );
    this.habitat = new HabitatKernel({
      computerBaseDir,
      cards: this.cards,
      grants: this.grants,
      effects: this.effects,
      agents: this.agents,
      orchestrator: this.orchestrator,
      adapter: opts?.adapter ?? new DeepAgentsAdapter(),
      now: opts?.now,
      tickMs: opts?.tickMs,
    });
    this.architect = new ArchitectSurface({
      agents: this.agents,
      habitat: this.habitat,
      grants: this.grants,
      eval: this.eval,
      packs: this.packs,
    });
  }

  static async boot(opts: KernelOptions): Promise<AlphaVectorCore> {
    const stateDir = opts.stateDir ?? path.join(opts.computer.baseDir, "state");
    const core = new AlphaVectorCore(opts.anchors, stateDir, opts.computer.baseDir);
    core.computer = await ComputerHost.create(opts.computer);
    core.habitat.attachComputer(core.computer);
    return core;
  }
}
