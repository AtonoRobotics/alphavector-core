import { AvError, SurfaceViolationError } from "../errors.js";
import type { CardBook } from "../auth/cards.js";
import type { DurableStore } from "../data/store.js";
import type { Journey } from "../data/types.js";
import type { EffectExecutor } from "../effects/executor.js";
import type { GrantBook } from "../grants/store.js";
import { JourneyRuntime } from "../journeys/runtime.js";
import type { LoadedPack, PrincipalKind } from "../packs/types.js";
import { AskSurface } from "./ask.js";
import type {
  FieldAskInput,
  FieldHome,
  FieldProgressInput,
  FieldProgressResult,
  FieldStartInput,
} from "./types.js";

const FORBIDDEN_FIELD = [
  "model",
  "prompt",
  "temporal",
  "tool schema",
  "trust tier",
  "trust ladder",
  "skill promotion",
];

export class FieldSurface {
  constructor(
    private readonly cards: CardBook,
    private readonly store: DurableStore,
    private readonly grants: GrantBook,
    private readonly journeys: JourneyRuntime = new JourneyRuntime(store),
    private readonly effects?: EffectExecutor,
    private readonly askSurface: AskSurface = new AskSurface(store),
  ) {}

  home(tenantId: string): FieldHome {
    return {
      journeys: this.store.journeys
        .filter((j) => j.tenantId === tenantId)
        .map((j) => ({ id: j.id, kind: j.journeyKind, objective: j.objective })),
      inbox: this.cards.fieldInbox(tenantId).map((c) => ({
        cardId: c.cardId,
        purpose: c.purpose,
        subject: c.subject,
        channel: c.channel,
      })),
      outboundLog: this.store.actions
        .filter((a) => a.tenantId === tenantId && a.status === "executed")
        .map((a) => ({ actionId: a.id, summary: `${a.actionClass} ${a.channel ?? ""}`.trim() })),
      killSwitch: { available: true },
      architectControls: [],
    };
  }

  /**
   * Required field path. Architect cannot start journeys here.
   * journeyKind must already be bound on the architect-loaded pack.
   */
  start(input: FieldStartInput): Journey {
    this.assertActorIsField(input.actor);
    this.assertFieldSafe(input.journeyKind);
    this.assertFieldSafe(input.objective);
    this.assertPackJourneyKind(input.pack, input.journeyKind);
    return this.journeys.open(input.pack.tenantId, input.journeyKind, input.objective);
  }

  /**
   * Progress an open pack journey. Ask is optional and is not required to advance.
   * External effects go through EffectExecutor so owner cards fire; card deny is
   * terminal via CardBook.wasDenied (no second deny store).
   */
  progress(input: FieldProgressInput): FieldProgressResult {
    this.assertActorIsField(input.actor);
    if (input.note) this.assertFieldSafe(input.note);
    const journey = this.store.journeys.find((j) => j.id === input.journeyId);
    if (!journey || journey.tenantId !== input.pack.tenantId) {
      throw new AvError("JOURNEY_NOT_FOUND", `Unknown journey ${input.journeyId}`);
    }
    this.assertPackJourneyKind(input.pack, journey.journeyKind);

    if (input.ask) {
      this.ask({ actor: input.actor, pack: input.pack, ...input.ask });
    }

    let effect: FieldProgressResult["effect"];
    if (input.actionClass) {
      if (!input.agent) {
        throw new AvError("AGENT_REQUIRED", "Field progress effects require a pack agent");
      }
      if (input.agent.tenantId !== input.pack.tenantId) {
        throw new AvError("AGENT_TENANT_MISMATCH", "Agent is not bound to this tenant");
      }
      if (!this.effects) {
        throw new AvError("EFFECTS_UNBOUND", "Field path is not bound to an effect executor");
      }
      if (input.purpose) this.assertFieldSafe(input.purpose);
      if (input.subject) this.assertFieldSafe(input.subject);
      effect = this.effects.execute({
        pack: input.pack,
        agent: input.agent,
        actionClass: input.actionClass,
        channel: input.channel,
        purpose: input.purpose,
        subject: input.subject ?? journey.journeyKind,
        surface: "field",
        approvedCardId: input.approvedCardId,
      });
    }

    this.journeys.progress(journey.id);
    this.store.addEvidence({
      tenantId: input.pack.tenantId,
      kind: "journey_progress",
      payload: {
        journeyId: journey.id,
        journeyKind: journey.journeyKind,
        note: input.note,
        actionId: effect?.actionId,
      },
      producedBy: input.agent?.agentId ?? "field",
    });
    return { journey, effect };
  }

  /** Optional sidecar. Cannot exceed pack Ask ceilings. A deny stays denied. */
  ask(input: FieldAskInput): void {
    this.assertActorIsField(input.actor);
    this.assertFieldSafe(input.text);
    this.askSurface.assertAllowed(input.pack, {
      tenantId: input.tenantId,
      agentName: input.agentName,
      text: input.text,
      actionClass: input.actionClass,
    });
  }

  kill(tenantId: string, reason: string): void {
    this.grants.kill({ tenantId, reason });
  }

  assertFieldSafe(text: string): void {
    const lowered = text.toLowerCase();
    for (const word of FORBIDDEN_FIELD) {
      if (lowered.includes(word)) {
        throw new SurfaceViolationError(`Field surface must not expose ${word}`);
      }
    }
  }

  private assertActorIsField(actor: PrincipalKind): void {
    if (actor !== "field") {
      throw new SurfaceViolationError("Only a field user may use the field path");
    }
  }

  private assertPackJourneyKind(pack: LoadedPack, journeyKind: string): void {
    if (!pack.binding.journeyKinds.some((k) => k.id === journeyKind)) {
      throw new AvError(
        "UNKNOWN_JOURNEY_KIND",
        `Journey kind ${journeyKind} is not bound on the loaded pack`,
      );
    }
  }
}
