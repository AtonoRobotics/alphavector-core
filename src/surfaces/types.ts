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

export interface ArchitectHome {
  grants: true;
  packLoad: true;
  evaluation: true;
  connectors: true;
  fieldOwnerAuth: false;
}
