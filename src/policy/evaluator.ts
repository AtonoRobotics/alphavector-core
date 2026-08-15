import type { PolicyBodies, PolicyRule } from "../packs/types.js";
import type { EffectRequest, FixtureEvalResult, PolicyDecision } from "./types.js";

function matches(rule: PolicyRule, req: EffectRequest): boolean {
  const w = rule.when;
  if (w.actionClass && w.actionClass !== req.actionClass) return false;
  if (w.channel && w.channel !== req.channel) return false;
  if (w.purpose && w.purpose !== req.purpose) return false;
  if (w.jurisdiction && w.jurisdiction !== req.jurisdiction) return false;
  return true;
}

export function evaluateRules(policy: PolicyBodies, req: EffectRequest): PolicyDecision {
  const bodies = [...policy.jurisdiction, ...policy.licensedAction, ...policy.consent];
  const matched = bodies.filter((rule) => matches(rule, req));
  const deny = matched.find((rule) => rule.decision === "deny");
  if (deny) {
    return {
      allowed: false,
      reason: deny.reason,
      ruleIds: [deny.id],
      policyAuth: true,
    };
  }
  const allow = matched.filter((rule) => rule.decision === "allow");
  if (allow.length === 0) {
    return {
      allowed: false,
      reason: "No matching pack policy rule; fail closed",
      ruleIds: [],
      policyAuth: true,
    };
  }
  return {
    allowed: true,
    reason: allow[0]!.reason,
    ruleIds: allow.map((r) => r.id),
    policyAuth: true,
  };
}

export function evaluateAdversarialFixtures(policy: PolicyBodies): FixtureEvalResult {
  const failed: string[] = [];
  for (const fixture of policy.adversarialFixtures) {
    const decision = evaluateRules(policy, {
      tenantId: "fixture",
      agentId: "fixture",
      actionClass: fixture.input.actionClass,
      channel: fixture.input.channel,
      purpose: fixture.input.purpose,
      jurisdiction: fixture.input.jurisdiction,
      surface: "system",
    });
    const got = decision.allowed ? "allow" : "deny";
    if (got !== fixture.expect) {
      failed.push(`${fixture.id}: expected ${fixture.expect}, got ${got}`);
    }
  }
  if (failed.length > 0) {
    return { ok: false, message: `Adversarial fixtures failed: ${failed.join("; ")}`, failed };
  }
  return { ok: true, message: "adversarial fixtures passed", failed: [] };
}
