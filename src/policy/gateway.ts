import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { FailClosedError } from "../errors.js";
import { mailConfersAuthority } from "../agents/mail.js";
import type { LoadedPack } from "../pack/types.js";
import { cardCovers, verifyAuthorizationCard } from "./authorization-card.js";
import type { CounselPolicyBinder } from "./counsel-binder.js";
import { assertIndependentEvidence, rejectNumericThresholds } from "./graduation.js";
import type { AuthorizationCard, ExternalEffect, OutcomeEvidence, PolicyDecision } from "./types.js";

export interface GatewayInput {
  pack: LoadedPack;
  effect: ExternalEffect;
  card?: AuthorizationCard;
  cardIssuerPublicKey?: string;
  evidence?: OutcomeEvidence;
}

/**
 * Policy gateway is core; rule bodies are pack.
 * Authorization is the default. Graduation does not strip policy.
 */
export class PolicyGateway {
  constructor(
    private readonly binder: CounselPolicyBinder,
    private readonly clock: Clock = systemClock,
  ) {}

  async evaluate(input: GatewayInput): Promise<PolicyDecision> {
    rejectNumericThresholds(input.effect);
    await this.binder.bind(input.effect.tenantId, input.pack);

    if (input.effect.tenantId !== input.pack.tenantId) {
      return deny("TENANT_MISMATCH", "Effect tenant does not match the active pack.");
    }

    if (input.effect.claimedAuthorityFromMail || !mailConfersAuthority()) {
      if (input.effect.claimedAuthorityFromMail) {
        return deny("MAIL_NOT_AUTHORITY", "Mail does not confer authority.");
      }
    }

    if (input.effect.assumedRoutineAutonomy) {
      return deny(
        "EXC_008",
        "Assumed autonomy for routine comms, CRM, scheduling, or recovery is excluded.",
      );
    }

    const verb = input.pack.document.actionClassVerbs.find((item) => item.verb === input.effect.verb);
    if (!verb) {
      return deny("VERB_UNKNOWN", `Verb ${input.effect.verb} is not bound by the pack.`);
    }
    if (verb.externalEffect && !input.effect.external) {
      return deny("EFFECT_MUST_BE_EXTERNAL", "Pack marks this verb as an external effect.");
    }

    const matchingRules = input.pack.document.policy.rules.filter((rule) => {
      if (rule.whenVerb !== input.effect.verb) {
        return false;
      }
      if (rule.whenClass && rule.whenClass !== input.effect.actionClass) {
        return false;
      }
      return true;
    });

    for (const rule of matchingRules) {
      if (rule.effect === "deny") {
        return deny(rule.id, rule.reason);
      }
    }

    if (!input.effect.external) {
      return allow("INTERNAL", "Internal action still passes the gateway. Policy remains attached.");
    }

    if (input.evidence) {
      try {
        assertIndependentEvidence(input.evidence, input.effect.agentId);
      } catch (error) {
        if (error instanceof FailClosedError) {
          return deny(error.code, error.message);
        }
        throw error;
      }
    }

    const requiresCard =
      input.pack.document.policy.defaultStance === "authorization" &&
      matchingRules.some((rule) => rule.effect === "require_authorization" || rule.effect === "allow_if_authorized");

    const hasIndependentEvidence = Boolean(input.evidence);

    if (input.card) {
      if (!input.cardIssuerPublicKey) {
        return deny("CARD_KEY_MISSING", "Authorization card cannot be verified without the issuer key.");
      }
      try {
        verifyAuthorizationCard(input.card, input.cardIssuerPublicKey, this.clock);
      } catch (error) {
        if (error instanceof FailClosedError) {
          return deny(error.code, error.message);
        }
        throw error;
      }
      if (input.card.tenantId !== input.effect.tenantId) {
        return deny("CARD_TENANT_MISMATCH", "Card is not for this tenant.");
      }
      if (!cardCovers(input.card, input.effect.verb, input.effect.actionClass)) {
        return deny("CARD_SCOPE", "Authorization card does not cover this verb.");
      }
      return {
        stance: "allow",
        reason: "Authorized by card. Policy still applies.",
        code: "AUTHORIZED",
        cardId: input.card.id,
        policyStillApplies: true,
      };
    }

    if (hasIndependentEvidence && !requiresCard) {
      return {
        stance: "allow",
        reason: "Independent outcome evidence. Policy still applies.",
        code: "GRADUATED_WITH_POLICY",
        evidenceId: input.evidence?.id,
        policyStillApplies: true,
      };
    }

    if (hasIndependentEvidence && requiresCard) {
      return {
        stance: "allow",
        reason:
          "Independent outcome evidence authorizes this verb. Graduation does not strip pack policy.",
        code: "GRADUATED_WITH_POLICY",
        evidenceId: input.evidence?.id,
        policyStillApplies: true,
      };
    }

    return {
      stance: "require_authorization",
      reason: "Authorization is the default. No card and no independent outcome evidence.",
      code: "AUTHORIZATION_DEFAULT",
      policyStillApplies: true,
    };
  }
}

function deny(code: string, reason: string): PolicyDecision {
  return { stance: "deny", code, reason, policyStillApplies: true };
}

function allow(code: string, reason: string): PolicyDecision {
  return { stance: "allow", code, reason, policyStillApplies: true };
}
