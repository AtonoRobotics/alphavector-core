import type { AgentRecord } from "../agents/types.js";
import type { Journey } from "../data/types.js";
import type { LoadedPack, PrincipalKind } from "../packs/types.js";

export type SurfaceName = "field" | "ask" | "architect";

export interface FieldHome {
  journeys: Array<{ id: string; kind: string; objective: string }>;
  inbox: Array<{ cardId: string; purpose: string; subject: string; channel: string }>;
  outboundLog: Array<{ actionId: string; summary: string }>;
  killSwitch: { available: true };
  architectControls: never[];
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
}

export interface FieldProgressResult {
  journey: Journey;
  effect?: { actionId: string; executed: boolean; policyDecision: string };
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
