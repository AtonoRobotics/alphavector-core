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

export interface ArchitectHome {
  grants: true;
  packLoad: true;
  evaluation: true;
  connectors: true;
  fieldOwnerAuth: false;
}
