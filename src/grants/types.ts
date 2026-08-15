/**
 * Authorization is the default (DEC-010). DEC-017 / T0-T3 are not accepted.
 * Stored grants are Architect-written owner-auth. Absence means authorization required.
 */
export type GrantState = "requires_authorization" | "authorized" | "revoked";

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
