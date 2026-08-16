import { AuthorizationRequiredError, AvError, SurfaceViolationError } from "../errors.js";
import type { CardBook } from "../auth/cards.js";
import type { AuthorizationCard, FieldCardView } from "../auth/types.js";
import type { DurableStore } from "../data/store.js";
import type { Journey } from "../data/types.js";
import type { EffectExecutor } from "../effects/executor.js";
import { FactBook } from "../facts/book.js";
import type { GrantBook } from "../grants/store.js";
import { JourneyRuntime } from "../journeys/runtime.js";
import { evaluateDeclaredPredicates } from "../packs/predicates.js";
import type { LoadedPack, PackBinding, PredicateDeclaration, PrincipalKind } from "../packs/types.js";
import { AskSurface } from "./ask.js";
import type {
  FieldAskInput,
  FieldFactInput,
  FieldFactResult,
  FieldHome,
  FieldProgressInput,
  FieldProgressResult,
  FieldStartInput,
} from "./types.js";

/** Field fact write/retract. Not a pack action class and not an RE type. */
const FACT_CHANNEL = "facts";
const FACT_AGENT = "field";
const PURPOSE_PREFIX = "purpose.";

function isPurposeFactId(id: string): boolean {
  return id.startsWith(PURPOSE_PREFIX) && id.length > PURPOSE_PREFIX.length;
}

/**
 * Unique purpose.* ids from loaded pack bindings (REQUIRES and PREFERS only).
 * AVOIDS are not collected. Does not invent ids. Label from fieldLanguageMap, else id.
 */
export function purposeFactsFromBinding(binding: PackBinding): Array<{ id: string; label: string }> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const take = (values: readonly string[] | undefined) => {
    for (const id of values ?? []) {
      if (typeof id === "string" && isPurposeFactId(id) && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  };
  // Action verbs first so communicate REQUIRES purpose is on the list for the field path.
  for (const verb of binding.actionClassVerbs) {
    take(verb.REQUIRES);
    take(verb.PREFERS);
  }
  for (const kind of binding.journeyKinds) {
    take(kind.REQUIRES);
    take(kind.PREFERS);
  }
  const map = binding.fieldLanguageMap;
  return ids.map((id) => ({ id, label: map[id] ?? id }));
}

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
      purposeFacts: pack ? purposeFactsFromBinding(pack.binding) : [],
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

  /**
   * Request to record a generic fact. Issues an owner_instance card.
   * Does not write facts.json until the card is approved.
   */
  record(input: FieldFactInput): void {
    this.requestFactWrite(input, "record");
  }

  /**
   * Request to retract a generic fact. Issues an owner_instance card.
   * Does not change facts.json until the card is approved.
   */
  retract(input: FieldFactInput): void {
    this.requestFactWrite(input, "retract");
  }

  /**
   * Persist or retract only after the owner_instance card is approved.
   * Pending and denied cards do not write. Non-fact cards return undefined
   * so communicate approve-then-execute can continue.
   */
  commitApprovedFact(cardId: string): FieldFactResult | undefined {
    const card = this.cards.get(cardId);
    if (!card || card.channel !== FACT_CHANNEL) return undefined;
    if (card.status !== "approved") {
      throw new AvError("CARD_NOT_APPROVED", "Fact write requires an approved card");
    }
    if (card.actionClass === "record") {
      this.facts.put(card.tenantId, card.subject);
      return { id: card.subject, present: true };
    }
    if (card.actionClass === "retract") {
      this.facts.retract(card.tenantId, card.subject);
      return { id: card.subject, present: false };
    }
    return undefined;
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

  private requestFactWrite(input: FieldFactInput, op: "record" | "retract"): void {
    this.assertActorIsField(input.actor);
    if (!input.id) {
      throw new AvError("FACT_ID_REQUIRED", "Fact id is required");
    }
    this.assertFieldSafe(input.id);
    if (this.cards.wasDenied(input.pack.tenantId, FACT_AGENT, op, input.id, FACT_CHANNEL)) {
      throw new AvError(
        "DENY_IS_TERMINAL",
        "Deny is terminal; the same action cannot be silently resubmitted",
      );
    }
    const card = this.cards.issue({
      tenantId: input.pack.tenantId,
      kind: "owner_instance",
      actionClass: op,
      agentId: FACT_AGENT,
      purpose: op,
      subject: input.id,
      channel: FACT_CHANNEL,
      pack: input.pack,
    });
    throw new AuthorizationRequiredError(card.cardId, "Authorization card required before fact write");
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
