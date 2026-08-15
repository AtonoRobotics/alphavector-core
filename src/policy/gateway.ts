import { PolicyDeniedError } from "../errors.js";
import type { LoadedPack } from "../packs/types.js";
import { evaluateRules } from "./evaluator.js";
import type { EffectRequest, PolicyDecision } from "./types.js";

/**
 * Deterministic policy gateway. Core. Rule bodies are pack.
 * Graduation SHALL NOT strip or skip this gate (DEC-012 / DEC-022).
 */
export class PolicyGateway {
  decide(pack: LoadedPack, req: EffectRequest): PolicyDecision {
    if (req.tenantId !== pack.tenantId) {
      return {
        allowed: false,
        reason: "Tenant mismatch",
        ruleIds: [],
        policyAuth: true,
      };
    }
    const verb = pack.binding.actionClassVerbs.find((v) => v.id === req.actionClass);
    if (!verb) {
      return {
        allowed: false,
        reason: `Unknown action class ${req.actionClass}`,
        ruleIds: [],
        policyAuth: true,
      };
    }
    if (verb.ceiling === "prohibited") {
      return {
        allowed: false,
        reason: `Action class ${req.actionClass} is prohibited`,
        ruleIds: [],
        policyAuth: true,
      };
    }
    if (req.claimedAuthorityFromMail) {
      return {
        allowed: false,
        reason: "Mail does not confer authority",
        ruleIds: [],
        policyAuth: true,
      };
    }
    if (req.assumedRoutineAutonomy) {
      return {
        allowed: false,
        reason: "EXC-008: assumed autonomy for routine comms, CRM, scheduling, or recovery is excluded",
        ruleIds: [],
        policyAuth: true,
      };
    }
    return evaluateRules(pack.binding.policy, req);
  }

  assertAllowed(pack: LoadedPack, req: EffectRequest): PolicyDecision {
    const decision = this.decide(pack, req);
    if (!decision.allowed) {
      throw new PolicyDeniedError(decision.reason);
    }
    return decision;
  }
}
