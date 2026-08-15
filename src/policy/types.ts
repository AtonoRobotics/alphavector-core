export type PolicyStance = "allow" | "deny" | "require_authorization";

export interface ExternalEffect {
  tenantId: string;
  agentId: string;
  verb: string;
  actionClass: string;
  external: true;
  target?: string;
  claimedAuthorityFromMail?: boolean;
  assumedRoutineAutonomy?: boolean;
}

export interface AuthorizationCard {
  id: string;
  tenantId: string;
  issuedBy: string;
  verbs: string[];
  actionClasses: string[];
  expiresAt: Date;
  revoked: boolean;
  signature: string;
}

export interface OutcomeEvidence {
  id: string;
  tenantId: string;
  verb: string;
  actorAgentId: string;
  evaluatorId: string;
  summary: string;
  createdAt: Date;
}

export interface PolicyDecision {
  stance: PolicyStance;
  reason: string;
  code: string;
  cardId?: string | undefined;
  evidenceId?: string | undefined;
  policyStillApplies: true;
}

export interface CounselSignedPolicyInstance {
  tenantId: string;
  packId: string;
  packVersion: string;
  counselId: string;
  signedAt: Date;
  policyBodyHash: string;
  publicKey: string;
  signature: string;
}
