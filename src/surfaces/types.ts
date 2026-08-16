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
  records: Array<{ id: string; type: string; label: string; attributes: Record<string, string> }>;
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
   * Subject record this journey is about. Required. Missing fails closed.
   * Journey REQUIRES/AVOIDS eval uses that record's present set only —
   * never the tenant-global set as a fallback.
   */
  recordId: string;
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
  /**
   * Subject record this action is about. Required when actionClass is set
   * so REQUIRES/AVOIDS/PREFERS eval uses that record's present set only.
   * Missing fails closed (`RECORD_ID_REQUIRED`). Unknown fails closed
   * (`RECORD_NOT_FOUND`). Progress without actionClass does not require it.
   */
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
  /**
   * Subject record this fact is about. Required. Missing fails closed.
   * Purpose, AVOIDS, and generic fact writes use that record's present
   * set only — never the tenant-global set as a fallback.
   */
  recordId: string;
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

/**
 * Field-only record update. recordId is required. Missing fails closed
 * (`RECORD_ID_REQUIRED`). Unknown fails closed (`RECORD_NOT_FOUND`).
 * type is a pack string. attributes are generic string keys and values.
 */
export interface FieldRecordUpdateInput {
  actor: PrincipalKind;
  pack: LoadedPack;
  recordId: string;
  type?: string;
  label?: string;
  attributes?: Record<string, string>;
}

export interface FieldRecordResult {
  id: string;
  type: string;
  label: string;
  attributes: Record<string, string>;
}

export interface ArchitectHome {
  grants: true;
  packLoad: true;
  evaluation: true;
  connectors: true;
  fieldOwnerAuth: false;
}
