import { AuthorizationRequiredError, AvError, PolicyDeniedError } from "../errors.js";
import type { AgentRecord } from "../agents/types.js";
import type { CardBook } from "../auth/cards.js";
import type { DurableStore } from "../data/store.js";
import type { GrantBook } from "../grants/store.js";
import type { LoadedPack } from "../packs/types.js";
import type { PolicyGateway } from "../policy/gateway.js";
import type { EffectRequest } from "../policy/types.js";

export interface EffectInput {
  pack: LoadedPack;
  agent: AgentRecord;
  actionClass: string;
  channel?: string;
  purpose?: string;
  jurisdiction?: string;
  subject?: string;
  surface: EffectRequest["surface"];
  approvedCardId?: string;
  claimedAuthorityFromMail?: boolean;
  assumedRoutineAutonomy?: boolean;
  /**
   * Habitat sets false, invokes the live connector, then commitExternal.
   * Default true keeps FieldSurface.progress ledger-only (leftover).
   */
  recordExecution?: boolean;
}

export interface EffectResult {
  actionId: string;
  executed: boolean;
  policyDecision: string;
}

/**
 * Every external effect: policy gateway AND authorization card primitive.
 * Graduation cannot strip the gateway. Mail cannot skip a card.
 */
export class EffectExecutor {
  constructor(
    private readonly gateway: PolicyGateway,
    private readonly grants: GrantBook,
    private readonly cards: CardBook,
    private readonly store: DurableStore,
  ) {}

  execute(input: EffectInput): EffectResult {
    const verb = input.pack.binding.actionClassVerbs.find((v) => v.id === input.actionClass);
    if (!verb) throw new AvError("UNKNOWN_ACTION_CLASS", input.actionClass);

    const req: EffectRequest = {
      tenantId: input.pack.tenantId,
      agentId: input.agent.agentId,
      actionClass: input.actionClass,
      channel: input.channel,
      purpose: input.purpose,
      jurisdiction: input.jurisdiction,
      subjectId: input.subject,
      surface: input.surface,
      claimedAuthorityFromMail: input.claimedAuthorityFromMail,
      assumedRoutineAutonomy: input.assumedRoutineAutonomy,
    };

    const policy = this.gateway.decide(input.pack, req);
    if (!policy.allowed) {
      throw new PolicyDeniedError(policy.reason);
    }

    const action = this.store.proposeAction({
      tenantId: input.pack.tenantId,
      actionClass: input.actionClass,
      agentId: input.agent.agentId,
      channel: input.channel,
      purpose: input.purpose,
      subjectId: input.subject,
    });

    if (!verb.externalEffect) {
      this.store.updateAction(action.id, "executed");
      this.store.addEvidence({
        tenantId: input.pack.tenantId,
        kind: "internal_read",
        payload: { actionId: action.id, policy: policy.reason },
        producedBy: input.agent.agentId,
      });
      return { actionId: action.id, executed: true, policyDecision: policy.reason };
    }

    if (
      this.cards.wasDenied(
        input.pack.tenantId,
        input.agent.agentId,
        input.actionClass,
        input.subject ?? "",
        input.channel ?? "",
      )
    ) {
      this.store.updateAction(action.id, "denied");
      throw new AvError("DENY_IS_TERMINAL", "Deny is terminal; the same action cannot be silently resubmitted");
    }

    const grantState = this.grants.state(input.pack.tenantId, input.agent.agentId, input.actionClass);
    if (grantState === "revoked") {
      this.store.updateAction(action.id, "denied");
      throw new AvError("GRANT_REVOKED", "Grant revoked; no execution");
    }

    const needsCard = grantState !== "authorized" || verb.ceiling === "human_decision";
    if (needsCard) {
      if (!input.approvedCardId) {
        const card = this.cards.issue({
          tenantId: input.pack.tenantId,
          kind: input.surface === "architect" ? "architect_admin" : "owner_instance",
          actionClass: input.actionClass,
          agentId: input.agent.agentId,
          purpose: input.purpose ?? "unspecified",
          subject: input.subject ?? "unspecified",
          channel: input.channel ?? "unspecified",
          pack: input.pack,
        });
        this.store.addEvidence({
          tenantId: input.pack.tenantId,
          kind: "auth_card",
          payload: { cardId: card.cardId, actionId: action.id },
          producedBy: "core",
        });
        throw new AuthorizationRequiredError(card.cardId, "Authorization card required before execution");
      }
      const card = this.cards.get(input.approvedCardId);
      if (!card || card.status !== "approved") {
        throw new AuthorizationRequiredError(input.approvedCardId, "Card is not approved");
      }
    }

    if (input.recordExecution === false) {
      return { actionId: action.id, executed: false, policyDecision: policy.reason };
    }
    return this.commitExternal(action.id, input, policy.reason);
  }

  /**
   * Persist executed only after the habitat reached the world.
   * Admission without a world call must not use this.
   */
  commitExternal(actionId: string, input: EffectInput, policyDecision: string): EffectResult {
    const grantState = this.grants.state(input.pack.tenantId, input.agent.agentId, input.actionClass);
    this.store.updateAction(actionId, "executed");
    this.store.addEvidence({
      tenantId: input.pack.tenantId,
      kind: "external_effect",
      payload: { actionId, policy: policyDecision, grantState },
      producedBy: input.agent.agentId,
    });
    this.store.addInteraction(
      input.pack.tenantId,
      input.channel ?? "system",
      [input.agent.agentId],
      `${input.actionClass} executed`,
    );
    return { actionId, executed: true, policyDecision };
  }
}
