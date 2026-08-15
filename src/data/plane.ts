import { FailClosedError } from "../errors.js";
import { newId } from "../ids.js";
import type { LoadedPack } from "../pack/types.js";
import type { Assertion, GraphEdge, Journey, Party, RecordItem } from "./types.js";

export interface DataPlaneStore {
  insertParty(party: Party): Promise<void>;
  insertRecord(record: RecordItem): Promise<void>;
  insertJourney(journey: Journey): Promise<void>;
  insertAssertion(assertion: Assertion): Promise<void>;
  insertEdge(edge: GraphEdge): Promise<void>;
  listParties(tenantId: string): Promise<Party[]>;
  listRecords(tenantId: string): Promise<RecordItem[]>;
  listJourneys(tenantId: string): Promise<Journey[]>;
  listAssertions(tenantId: string): Promise<Assertion[]>;
  listEdges(tenantId: string): Promise<GraphEdge[]>;
}

export class MemoryDataPlaneStore implements DataPlaneStore {
  readonly parties: Party[] = [];
  readonly records: RecordItem[] = [];
  readonly journeys: Journey[] = [];
  readonly assertions: Assertion[] = [];
  readonly edges: GraphEdge[] = [];

  async insertParty(party: Party): Promise<void> {
    this.parties.push(party);
  }
  async insertRecord(record: RecordItem): Promise<void> {
    this.records.push(record);
  }
  async insertJourney(journey: Journey): Promise<void> {
    this.journeys.push(journey);
  }
  async insertAssertion(assertion: Assertion): Promise<void> {
    this.assertions.push(assertion);
  }
  async insertEdge(edge: GraphEdge): Promise<void> {
    this.edges.push(edge);
  }
  async listParties(tenantId: string): Promise<Party[]> {
    return this.parties.filter((item) => item.tenantId === tenantId);
  }
  async listRecords(tenantId: string): Promise<RecordItem[]> {
    return this.records.filter((item) => item.tenantId === tenantId);
  }
  async listJourneys(tenantId: string): Promise<Journey[]> {
    return this.journeys.filter((item) => item.tenantId === tenantId);
  }
  async listAssertions(tenantId: string): Promise<Assertion[]> {
    return this.assertions.filter((item) => item.tenantId === tenantId);
  }
  async listEdges(tenantId: string): Promise<GraphEdge[]> {
    return this.edges.filter((item) => item.tenantId === tenantId);
  }
}

export class DataPlane {
  constructor(private readonly store: DataPlaneStore) {}

  async createParty(pack: LoadedPack, kind: string, payload: Record<string, unknown>): Promise<Party> {
    assertKind(pack.document.bindings.partyKinds, kind, "party");
    const party: Party = {
      id: newId("party"),
      tenantId: pack.tenantId,
      kind,
      payload,
      createdAt: new Date(),
    };
    await this.store.insertParty(party);
    return party;
  }

  async createRecord(pack: LoadedPack, kind: string, payload: Record<string, unknown>): Promise<RecordItem> {
    assertKind(pack.document.bindings.recordKinds, kind, "record");
    const record: RecordItem = {
      id: newId("rec"),
      tenantId: pack.tenantId,
      kind,
      payload,
      createdAt: new Date(),
    };
    await this.store.insertRecord(record);
    return record;
  }

  async createJourney(pack: LoadedPack, kind: string, stage: string, payload: Record<string, unknown>): Promise<Journey> {
    const journeyKind = pack.document.journeyKinds.find((item) => item.id === kind);
    if (!journeyKind) {
      throw new FailClosedError("JOURNEY_KIND_UNBOUND", `Journey kind ${kind} is not bound by the pack.`);
    }
    if (!journeyKind.stages.includes(stage)) {
      throw new FailClosedError("JOURNEY_STAGE_UNBOUND", `Stage ${stage} is not bound for ${kind}.`);
    }
    const journey: Journey = {
      id: newId("journey"),
      tenantId: pack.tenantId,
      kind,
      stage,
      payload,
      createdAt: new Date(),
    };
    await this.store.insertJourney(journey);
    return journey;
  }

  async proposeAssertion(
    pack: LoadedPack,
    input: { subject: string; predicate: string; object: string; evidenceId?: string },
  ): Promise<Assertion> {
    const assertion: Assertion = {
      id: newId("assert"),
      tenantId: pack.tenantId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      status: "proposed",
      createdAt: new Date(),
      ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
    };
    await this.store.insertAssertion(assertion);
    return assertion;
  }

  async link(pack: LoadedPack, fromId: string, toId: string, kind: string): Promise<GraphEdge> {
    const edge: GraphEdge = {
      id: newId("edge"),
      tenantId: pack.tenantId,
      fromId,
      toId,
      kind,
    };
    await this.store.insertEdge(edge);
    return edge;
  }

  async retrieve(tenantId: string, query: string): Promise<{ records: RecordItem[]; assertions: Assertion[] }> {
    const needle = query.toLowerCase();
    const records = (await this.store.listRecords(tenantId)).filter((item) =>
      JSON.stringify(item.payload).toLowerCase().includes(needle),
    );
    const assertions = (await this.store.listAssertions(tenantId)).filter((item) =>
      `${item.subject} ${item.predicate} ${item.object}`.toLowerCase().includes(needle),
    );
    return { records, assertions };
  }
}

function assertKind(kinds: Array<{ id: string }>, kind: string, label: string): void {
  if (!kinds.some((item) => item.id === kind)) {
    throw new FailClosedError("KIND_UNBOUND", `${label} kind ${kind} is not bound by the pack.`);
  }
}
