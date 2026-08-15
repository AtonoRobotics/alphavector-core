import { AvError } from "../errors.js";
import { newId, nowIso } from "../ids.js";
import type {
  ActionRecord,
  Assertion,
  AssertionClass,
  Commitment,
  DurableMeta,
  Evidence,
  GraphEdge,
  GraphNode,
  Interaction,
  Journey,
  Outcome,
  Party,
  RecordObject,
} from "./types.js";

function meta(tenantId: string, prefix: string, lineage: string): DurableMeta {
  const ts = nowIso();
  return {
    tenantId,
    id: newId(prefix),
    version: 1,
    createdAt: ts,
    updatedAt: ts,
    sourceLineage: lineage,
    lifecycle: "active",
  };
}

/**
 * Pack-agnostic durable store (DEC-026).
 * PostgreSQL is the production business truth. This in-process book is the
 * same schema for tests and local runs. Memory entries cannot be written here
 * as facts.
 */
export class DurableStore {
  readonly parties: Party[] = [];
  readonly records: RecordObject[] = [];
  readonly journeys: Journey[] = [];
  readonly assertions: Assertion[] = [];
  readonly actions: ActionRecord[] = [];
  readonly outcomes: Outcome[] = [];
  readonly evidence: Evidence[] = [];
  readonly commitments: Commitment[] = [];
  readonly interactions: Interaction[] = [];
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];

  createParty(tenantId: string, partyKind: string, displayName: string): Party {
    const party: Party = { ...meta(tenantId, "party", "user"), partyKind, displayName };
    this.parties.push(party);
    return party;
  }

  createRecord(tenantId: string, recordKind: string, payload: Record<string, unknown>): RecordObject {
    const rec: RecordObject = { ...meta(tenantId, "rec", "user"), recordKind, payload };
    this.records.push(rec);
    return rec;
  }

  createJourney(tenantId: string, journeyKind: string, objective: string): Journey {
    const journey: Journey = {
      ...meta(tenantId, "journey", "user"),
      journeyKind,
      objective,
      status: "open",
    };
    this.journeys.push(journey);
    return journey;
  }

  assert(input: {
    tenantId: string;
    subjectType: string;
    subjectId: string;
    predicate: string;
    typedValue: unknown;
    classification: AssertionClass;
    confidence: number;
    sourceType: string;
    sourceId: string;
    sourceActor: string;
    actorIsModel?: boolean;
  }): Assertion {
    if (input.classification === "verified" && input.actorIsModel) {
      throw new AvError("MODEL_CANNOT_VERIFY", "A model SHALL NOT write verified assertions");
    }
    const assertion: Assertion = {
      ...meta(input.tenantId, "asrt", input.sourceId),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      predicate: input.predicate,
      typedValue: input.typedValue,
      classification: input.classification,
      confidence: input.confidence,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceActor: input.sourceActor,
    };
    this.assertions.push(assertion);
    return assertion;
  }

  proposeAction(input: {
    tenantId: string;
    actionClass: string;
    agentId: string;
    channel?: string;
    purpose?: string;
    subjectId?: string;
  }): ActionRecord {
    const action: ActionRecord = {
      ...meta(input.tenantId, "act", input.agentId),
      actionClass: input.actionClass,
      agentId: input.agentId,
      status: "proposed",
      channel: input.channel,
      purpose: input.purpose,
      subjectId: input.subjectId,
    };
    this.actions.push(action);
    return action;
  }

  updateAction(id: string, status: ActionRecord["status"]): ActionRecord {
    const action = this.actions.find((a) => a.id === id);
    if (!action) throw new AvError("ACTION_NOT_FOUND", id);
    action.status = status;
    action.version += 1;
    action.updatedAt = nowIso();
    return action;
  }

  addEvidence(input: {
    tenantId: string;
    kind: string;
    payload: Record<string, unknown>;
    producedBy: string;
  }): Evidence {
    const ev: Evidence = { ...meta(input.tenantId, "ev", input.producedBy), ...input };
    this.evidence.push(ev);
    return ev;
  }

  mutateEvidence(_id: string): never {
    throw new AvError("EVIDENCE_IMMUTABLE", "The executing agent cannot modify or delete its evidence");
  }

  deleteEvidence(_id: string): never {
    throw new AvError("EVIDENCE_IMMUTABLE", "The executing agent cannot modify or delete its evidence");
  }

  addOutcome(tenantId: string, actionId: string, summary: string): Outcome {
    const outcome: Outcome = {
      ...meta(tenantId, "out", actionId),
      actionId,
      independent: true,
      summary,
    };
    this.outcomes.push(outcome);
    return outcome;
  }

  addCommitment(tenantId: string, parties: string[], deadline?: string): Commitment {
    const c: Commitment = {
      ...meta(tenantId, "cmt", "user"),
      parties,
      deadline,
      status: "open",
    };
    this.commitments.push(c);
    return c;
  }

  addInteraction(tenantId: string, channel: string, participants: string[], summary: string): Interaction {
    const i: Interaction = {
      ...meta(tenantId, "ix", "user"),
      channel,
      participants,
      summary,
    };
    this.interactions.push(i);
    return i;
  }

  projectNode(tenantId: string, kind: string, authoritativeId: string): GraphNode {
    const node: GraphNode = {
      tenantId,
      nodeId: newId("node"),
      kind,
      authoritativeId,
    };
    this.nodes.push(node);
    return node;
  }

  projectEdge(input: {
    tenantId: string;
    kind: string;
    fromId: string;
    toId: string;
    assertionId: string;
  }): GraphEdge {
    const edge: GraphEdge = { edgeId: newId("edge"), ...input };
    this.edges.push(edge);
    return edge;
  }

  retrieve(tenantId: string, query: string): Array<{ kind: string; id: string; text: string }> {
    const q = query.toLowerCase();
    const hits: Array<{ kind: string; id: string; text: string }> = [];
    for (const p of this.parties.filter((x) => x.tenantId === tenantId)) {
      if (p.displayName.toLowerCase().includes(q) || p.partyKind.toLowerCase().includes(q)) {
        hits.push({ kind: "party", id: p.id, text: p.displayName });
      }
    }
    for (const r of this.records.filter((x) => x.tenantId === tenantId)) {
      if (r.recordKind.toLowerCase().includes(q) || JSON.stringify(r.payload).toLowerCase().includes(q)) {
        hits.push({ kind: "record", id: r.id, text: r.recordKind });
      }
    }
    for (const j of this.journeys.filter((x) => x.tenantId === tenantId)) {
      if (j.objective.toLowerCase().includes(q) || j.journeyKind.toLowerCase().includes(q)) {
        hits.push({ kind: "journey", id: j.id, text: j.objective });
      }
    }
    return hits;
  }
}
