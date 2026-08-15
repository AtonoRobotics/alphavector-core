export type Lifecycle = "active" | "superseded" | "deleted" | "held";

export interface DurableMeta {
  tenantId: string;
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  sourceLineage: string;
  lifecycle: Lifecycle;
}

export interface Party extends DurableMeta {
  partyKind: string;
  displayName: string;
}

export interface RecordObject extends DurableMeta {
  recordKind: string;
  payload: Record<string, unknown>;
}

export interface Journey extends DurableMeta {
  journeyKind: string;
  objective: string;
  status: "open" | "paused" | "closed";
}

export type AssertionClass =
  | "verified"
  | "reported"
  | "observed"
  | "inferred"
  | "unknown"
  | "contradicted"
  | "expired";

export interface Assertion extends DurableMeta {
  subjectType: string;
  subjectId: string;
  predicate: string;
  typedValue: unknown;
  classification: AssertionClass;
  confidence: number;
  sourceType: string;
  sourceId: string;
  sourceActor: string;
}

export interface ActionRecord extends DurableMeta {
  actionClass: string;
  agentId: string;
  status: "proposed" | "authorized" | "executed" | "denied" | "reconciled";
  channel?: string;
  purpose?: string;
  subjectId?: string;
}

export interface Outcome extends DurableMeta {
  actionId: string;
  independent: true;
  summary: string;
}

export interface Evidence extends DurableMeta {
  kind: string;
  payload: Record<string, unknown>;
  producedBy: string;
}

export interface Commitment extends DurableMeta {
  parties: string[];
  deadline?: string;
  status: "open" | "kept" | "broken";
}

export interface Interaction extends DurableMeta {
  channel: string;
  participants: string[];
  summary: string;
}

export interface GraphNode {
  tenantId: string;
  nodeId: string;
  kind: string;
  authoritativeId: string;
}

export interface GraphEdge {
  tenantId: string;
  edgeId: string;
  kind: string;
  fromId: string;
  toId: string;
  assertionId: string;
}
