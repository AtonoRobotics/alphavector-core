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

/**
 * Proposed use checked against persisted GrantBounds.
 * Omitted dimensions are unconstrained only when the grant also omits them.
 * A set bound with no matching use is out of bound — fail closed.
 */
export interface GrantUse {
  channel?: string;
  purpose?: string;
  subject?: string;
  /**
   * Executed uses of this class in the last hour, from the durable action log.
   * Required when ratePerHour is set — a missing count is not a silent yes.
   */
  executedInLastHour?: number;
}

export type GrantBoundsCode = "GRANT_BOUNDS" | "GRANT_RATE";
export type GrantExpiryCode = "GRANT_EXPIRED";

/**
 * Why this use may not consume an authorized grant.
 * Undefined means the grant covers the use (or the bound is unset).
 */
export function grantBoundsRefusal(
  bounds: GrantBounds,
  use: GrantUse,
): { code: GrantBoundsCode; message: string } | undefined {
  if (bounds.channels && bounds.channels.length > 0) {
    if (use.channel === undefined || !bounds.channels.includes(use.channel)) {
      return { code: "GRANT_BOUNDS", message: "Grant does not cover this channel" };
    }
  }
  if (bounds.purposes && bounds.purposes.length > 0) {
    if (use.purpose === undefined || !bounds.purposes.includes(use.purpose)) {
      return { code: "GRANT_BOUNDS", message: "Grant does not cover this purpose" };
    }
  }
  if (bounds.subjectScope && bounds.subjectScope.length > 0) {
    if (use.subject === undefined || !bounds.subjectScope.includes(use.subject)) {
      return { code: "GRANT_BOUNDS", message: "Grant does not cover this subject" };
    }
  }
  if (bounds.ratePerHour !== undefined) {
    if (!Number.isFinite(bounds.ratePerHour) || bounds.ratePerHour < 0) {
      return { code: "GRANT_RATE", message: "Grant ratePerHour is not a usable limit; fail closed" };
    }
    if (use.executedInLastHour === undefined) {
      return {
        code: "GRANT_RATE",
        message: "Grant ratePerHour is set; refusing without an execution count",
      };
    }
    if (use.executedInLastHour >= bounds.ratePerHour) {
      return { code: "GRANT_RATE", message: "Grant ratePerHour exceeded" };
    }
  }
  return undefined;
}

/**
 * Why a set expiry refuses authorization.
 * Missing expiry is open-ended — not expired.
 * `now` is the kernel clock (`nowIso()`). Do not invent a second clock.
 */
export function grantExpiryRefusal(
  expiresAt: string | undefined,
  now: string,
): { code: GrantExpiryCode; message: string } | undefined {
  if (expiresAt && expiresAt < now) {
    return { code: "GRANT_EXPIRED", message: "Grant has expired" };
  }
  return undefined;
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
  /** Kernel-clock ISO time. Unset is open-ended. A set value that has passed is GRANT_EXPIRED. */
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
