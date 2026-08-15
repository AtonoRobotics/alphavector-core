/**
 * DEC-026: generic party / record / journey.
 * Packs bind kinds. Core does not bake Person / Listing / Household.
 */
export interface Party {
  id: string;
  tenantId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface RecordItem {
  id: string;
  tenantId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface Journey {
  id: string;
  tenantId: string;
  kind: string;
  stage: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface Assertion {
  id: string;
  tenantId: string;
  subject: string;
  predicate: string;
  object: string;
  evidenceId?: string | undefined;
  status: "proposed" | "supported" | "retracted";
  createdAt: Date;
}

export interface GraphEdge {
  id: string;
  tenantId: string;
  fromId: string;
  toId: string;
  kind: string;
}
