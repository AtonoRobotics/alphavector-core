import type { Journey } from "../data/types.js";
import type { PrincipalKind } from "../packs/types.js";

export type CardKind = "owner_instance" | "architect_admin";
export type CardStatus = "pending" | "approved" | "denied";

/** Approve-then-execute compose. Persisted with the card so restart can finish. */
export interface PendingProgressRecord {
  journeyId: string;
  actionClass: string;
  channel?: string;
  purpose?: string;
  subject?: string;
  /** Email/SMS send. Required at world invoke for those channels. */
  to?: string;
  body?: string;
  from?: string;
  agentId: string;
  journey: Journey;
}

export interface AuthorizationCard {
  cardId: string;
  tenantId: string;
  kind: CardKind;
  status: CardStatus;
  actionClass: string;
  agentId: string;
  purpose: string;
  subject: string;
  channel: string;
  fieldLanguage: {
    purpose: string;
    subject: string;
    channel: string;
    approve: string;
    deny: string;
  };
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface FieldCardView {
  cardId: string;
  purpose: string;
  subject: string;
  channel: string;
  approve: string;
  deny: string;
}

export interface ArchitectCardView extends AuthorizationCard {
  inspect: {
    agentId: string;
    actionClass: string;
    policyDecision?: string;
  };
}

export type FieldTokenStatus = "active" | "revoked";
/** Derived from a presented credential or bootstrap-once. Not a trusted caller string. */
export type FieldTokenIssuer = "architect" | "bootstrap";

/** Hashed tenant-issued credential. Secret is returned once at issue and never stored. */
export interface FieldTokenRecord {
  tokenId: string;
  tenantId: string;
  principal: PrincipalKind;
  hash: string;
  status: FieldTokenStatus;
  issuedAt: string;
  issuedBy: FieldTokenIssuer;
  revokedAt?: string;
}

export interface IssuedFieldToken {
  tokenId: string;
  tenantId: string;
  principal: PrincipalKind;
  token: string;
}
