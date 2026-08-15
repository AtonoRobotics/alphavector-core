export type CardKind = "owner_instance" | "architect_admin";
export type CardStatus = "pending" | "approved" | "denied";

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
