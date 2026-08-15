export interface EffectRequest {
  tenantId: string;
  agentId: string;
  actionClass: string;
  channel?: string;
  purpose?: string;
  jurisdiction?: string;
  subjectId?: string;
  surface: "field" | "ask" | "architect" | "system";
  claimedAuthorityFromMail?: boolean;
  assumedRoutineAutonomy?: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  ruleIds: string[];
  policyAuth: true;
}

export interface FixtureEvalResult {
  ok: boolean;
  message: string;
  failed: string[];
}
