/**
 * Authorization is the default (DEC-010). DEC-017 / T0-T3 are not accepted.
 * Stored grants are Architect-written owner-auth. Absence means authorization required.
 */
export type GrantState = "requires_authorization" | "authorized" | "revoked";

/**
 * Why the habitat loop may mint a new owner_instance card.
 * Re-ask without one of these is a habitat bug (HABITAT_REASK), not safety.
 * Not a T0–T3 ladder. Authorization remains the default.
 */
export const HABITAT_ASK_REASONS = ["no_grant", "grant_revoked", "class_mismatch", "human_decision"] as const;
export type HabitatAskReason = (typeof HABITAT_ASK_REASONS)[number];

export interface GrantBounds {
  channels?: string[];
  purposes?: string[];
  ratePerHour?: number;
  subjectScope?: string[];
}

export interface Grant {
  grantId: string;
  tenantId: string;
  agentId: string;
  actionClass: string;
  state: GrantState;
  bounds: GrantBounds;
  evidenceIds: string[];
  evalIds: string[];
  owner: string;
  issuedAt: string;
  expiresAt?: string;
  revokeReason?: string;
  fieldNoticeIssuedAt?: string;
}

export interface GraduationNotice {
  noticeId: string;
  tenantId: string;
  actionClass: string;
  businessLanguage: string;
  killSwitchAvailable: true;
  issuedAt: string;
}
