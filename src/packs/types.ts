export const REQUIRED_PACK_SECTIONS = [
  "identity",
  "roles",
  "journeyKinds",
  "actionClassVerbs",
  "policy",
  "connectors",
  "recordPartyKnowledge",
  "evidenceEvalFixtures",
  "askCeilings",
  "fieldLanguageMap",
] as const;

export type PackSection = (typeof REQUIRED_PACK_SECTIONS)[number];

export type PrincipalKind = "architect" | "counsel_eval" | "field";

export interface PackIdentity {
  packId: string;
  version: string;
  displayName: string;
}

export interface RoleBinding {
  name: string;
  persona: string;
  skills: string[];
  specialties: string[];
  isOrchestrator?: boolean;
}

/**
 * Optional declared condition lists on a journey or action binding.
 * Generic string ids from the loaded pack — not RE or Mission Control types.
 */
export interface PredicateDeclaration {
  REQUIRES?: string[];
  PREFERS?: string[];
  AVOIDS?: string[];
}

export interface JourneyKindBinding extends PredicateDeclaration {
  id: string;
  label: string;
}

export type ActionCeiling =
  | "authorization_required"
  | "bounded_autonomy"
  | "human_decision"
  | "prohibited"
  | "governance";

export interface ActionClassVerb extends PredicateDeclaration {
  id: string;
  label: string;
  externalEffect: boolean;
  startRequiresAuthorization: boolean;
  mayGraduate: boolean;
  ceiling: ActionCeiling;
}

export interface PolicyRule {
  id: string;
  when: {
    actionClass?: string;
    channel?: string;
    purpose?: string;
    jurisdiction?: string;
  };
  decision: "allow" | "deny";
  reason: string;
}

export interface PolicyBodies {
  jurisdiction: PolicyRule[];
  licensedAction: PolicyRule[];
  consent: PolicyRule[];
  adversarialFixtures: AdversarialFixture[];
}

export interface AdversarialFixture {
  id: string;
  description: string;
  input: {
    actionClass: string;
    channel?: string;
    purpose?: string;
    jurisdiction?: string;
  };
  expect: "allow" | "deny";
}

export interface ConnectorBinding {
  id: string;
  system: string;
  tools: string[];
}

export interface RecordPartyKnowledge {
  partyKinds: string[];
  recordKinds: string[];
  predicates: string[];
  corpora: string[];
  graphNodeKinds: string[];
  graphEdgeKinds: string[];
}

export interface EvidenceEvalFixture {
  id: string;
  description: string;
  countsAsIndependentOutcome: boolean;
  kind: string;
}

export interface FieldLanguageMap {
  [key: string]: string;
}

export interface PackSignatures {
  architect: string;
  counselEval: string;
}

export interface PackBinding {
  identity: PackIdentity;
  roles: RoleBinding[];
  journeyKinds: JourneyKindBinding[];
  actionClassVerbs: ActionClassVerb[];
  policy: PolicyBodies;
  connectors: ConnectorBinding[];
  recordPartyKnowledge: RecordPartyKnowledge;
  evidenceEvalFixtures: EvidenceEvalFixture[];
  askCeilings: string[];
  fieldLanguageMap: FieldLanguageMap;
  signatures?: PackSignatures;
}

export interface LoadedPack {
  tenantId: string;
  binding: PackBinding;
  loadedAt: string;
  loadedBy: "architect";
}

export interface PackLoadRefusal {
  ok: false;
  code: string;
  message: string;
}

export interface PackLoadSuccess {
  ok: true;
  loaded: LoadedPack;
}

export type PackLoadResult = PackLoadSuccess | PackLoadRefusal;
