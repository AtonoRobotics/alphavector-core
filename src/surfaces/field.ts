import { AvError, SurfaceViolationError } from "../errors.js";
import type { CardBook } from "../auth/cards.js";
import type { AuthorizationCard, FieldCardView } from "../auth/types.js";
import type { DurableStore } from "../data/store.js";
import type { Journey } from "../data/types.js";
import type { EffectExecutor } from "../effects/executor.js";
import { FactBook } from "../facts/book.js";
import type { GrantBook } from "../grants/store.js";
import { JourneyRuntime } from "../journeys/runtime.js";
import { evaluateDeclaredPredicates } from "../packs/predicates.js";
import type { LoadedPack, PredicateDeclaration, PrincipalKind } from "../packs/types.js";
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
    private readonly facts: FactBook = new FactBook(),
  ) {}

  home(tenantId: string, pack?: LoadedPack): FieldHome {
    return {
      journeys: this.store.journeys
        .filter((j) => j.tenantId === tenantId)
        .map((j) => ({ id: j.id, kind: j.journeyKind, objective: j.objective })),
      inbox: this.cards.fieldInbox(tenantId),
      outboundLog: this.store.actions
        .filter((a) => a.tenantId === tenantId && a.status === "executed")
        .map((a) => ({ actionId: a.id, summary: `${a.actionClass} ${a.channel ?? ""}`.trim() })),
      killSwitch: { available: true },
      architectControls: [],
      journeyKinds: pack
        ? pack.binding.journeyKinds.map((k) => ({ id: k.id, label: k.label }))
        : [],
    };
  }

  listCards(tenantId: string): FieldCardView[] {
    return this.cards.fieldInbox(tenantId);
  }

  /**
   * Field-only card resolve. Architect/admin cards cannot be touched here.
   * Approve-then-execute is composed by the caller (progress with approvedCardId).
   */
  resolveCard(input: {
    actor: PrincipalKind;
    cardId: string;
    decision: "approved" | "denied";
  }): AuthorizationCard {
    this.assertActorIsField(input.actor);
    const card = this.cards.get(input.cardId);
    if (!card) throw new AvError("CARD_NOT_FOUND", `Unknown card ${input.cardId}`);
    if (card.kind !== "owner_instance") {
      throw new SurfaceViolationError("Architect/admin cards SHALL NOT appear on the field surface");
    }
    return this.cards.resolve({
      cardId: input.cardId,
      decision: input.decision,
      actor: "field",
    });
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
    this.assertDeclaredPredicates(
      input.pack.tenantId,
      [this.journeyBinding(input.pack, input.journeyKind)],
      input.conditions,
    );
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
    const recordedPrefers = this.assertDeclaredPredicates(
      input.pack.tenantId,
      [
        this.journeyBinding(input.pack, journey.journeyKind),
        ...(input.actionClass ? [this.actionBinding(input.pack, input.actionClass)] : []),
      ],
      input.conditions,
    );

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
        recordedPrefers,
      },
      producedBy: input.agent?.agentId ?? "field",
    });
    return { journey, effect, recordedPrefers };
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

  private journeyBinding(pack: LoadedPack, journeyKind: string): PredicateDeclaration {
    return pack.binding.journeyKinds.find((k) => k.id === journeyKind) ?? {};
  }

  private actionBinding(pack: LoadedPack, actionClass: string): PredicateDeclaration {
    return pack.binding.actionClassVerbs.find((v) => v.id === actionClass) ?? {};
  }

  /**
   * Present-set is on-disk tenant facts. Request conditions are claims only:
   * they do not write the store and they do not satisfy REQUIRES or AVOIDS.
   */
  private assertDeclaredPredicates(
    tenantId: string,
    bindings: PredicateDeclaration[],
    claimed: readonly string[] | undefined,
  ): string[] {
    for (const condition of claimed ?? []) {
      this.assertFieldSafe(condition);
    }
    const present = this.facts.presentIds(tenantId);
    const recordedPrefers: string[] = [];
    for (const binding of bindings) {
      const decision = evaluateDeclaredPredicates(binding, present);
      if (!decision.allowed) {
        throw new AvError("PREDICATE_CLOSED", decision.reason);
      }
      for (const prefer of decision.recordedPrefers) {
        if (!recordedPrefers.includes(prefer)) recordedPrefers.push(prefer);
      }
    }
    return recordedPrefers;
  }
}
