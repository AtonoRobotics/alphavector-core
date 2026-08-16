import type { AgentRecord } from "../agents/types.js";
import type { FieldCardView } from "../auth/types.js";
import type { Journey } from "../data/types.js";
import type { LoadedPack, PrincipalKind } from "../packs/types.js";

export type SurfaceName = "field" | "ask" | "architect";

export interface FieldHome {
  journeys: Array<{ id: string; kind: string; objective: string }>;
  inbox: FieldCardView[];
  outboundLog: Array<{ actionId: string; summary: string }>;
  killSwitch: { available: true };
  architectControls: never[];
  journeyKinds: Array<{ id: string; label: string }>;
  /** Pack-local purpose.* facts from loaded bindings. Not a core constant. */
  purposeFacts: Array<{ id: string; label: string }>;
  /** Pack-local AVOIDS facts from loaded bindings. Not a core constant. */
  avoidFacts: Array<{ id: string; label: string }>;
  /** Generic subject records on this tenant's disk. Not an RE column. */
  records: Array<{ id: string; type: string; label: string }>;
  /**
   * Pack-local record/party kind strings from the loaded pack list.
   * Not hardcoded core types.
   */
  recordKinds: Array<{ id: string; label: string }>;
}

export interface AskRequest {
  tenantId: string;
  agentName?: string;
  text: string;
  actionClass: string;
}

/** Field-only start. journeyKind is a pack string, not a core RE column. */
export interface FieldStartInput {
  actor: PrincipalKind;
  pack: LoadedPack;
  journeyKind: string;
  objective: string;
  /**
   * Subject record this journey is about. Journey REQUIRES/AVOIDS eval
   * uses that record's present set. Absent = tenant-global facts.
   */
  recordId?: string;
  /**
   * Request claims only. Allow/deny uses persisted tenant facts on disk.
   * Passing a condition here does not write the fact store.
   */
  conditions?: readonly string[];
}

/** Field-only progress. Ask is an optional sidecar; effects go through EffectExecutor. */
export interface FieldProgressInput {
  actor: PrincipalKind;
  pack: LoadedPack;
  journeyId: string;
  agent?: AgentRecord;
  actionClass?: string;
  channel?: string;
  purpose?: string;
  subject?: string;
  approvedCardId?: string;
  ask?: AskRequest;
  note?: string;
  /**
   * Request claims only. Allow/deny uses persisted tenant facts on disk.
   * Passing a condition here does not write the fact store.
   */
  conditions?: readonly string[];
}

export interface FieldProgressResult {
  journey: Journey;
  effect?: { actionId: string; executed: boolean; policyDecision: string };
  recordedPrefers: string[];
}

export interface FieldAskInput extends AskRequest {
  actor: PrincipalKind;
  pack: LoadedPack;
}

/**
 * Field-only fact write/retract. `id` is a generic pack-local string
 * (e.g. condition.required), not an RE or Mission Control type.
 * Persist happens only after the owner_instance card is approved.
 */
export interface FieldFactInput {
  actor: PrincipalKind;
  pack: LoadedPack;
  id: string;
  /** Attach this fact to a subject record. Absent = tenant-global. */
  recordId?: string;
}

export interface FieldFactResult {
  id: string;
  present: boolean;
  recordId?: string;
}

/** Field-only record create. type is a pack string or a generic label. */
export interface FieldRecordInput {
  actor: PrincipalKind;
  pack: LoadedPack;
  type: string;
  label: string;
}

export interface FieldRecordResult {
  id: string;
  type: string;
  label: string;
}

export interface ArchitectHome {
  grants: true;
  packLoad: true;
  evaluation: true;
  connectors: true;
  fieldOwnerAuth: false;
}
