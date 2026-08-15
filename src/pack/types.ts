/**
 * Pack binding (DEC-019). Core is pack-agnostic.
 * Packs bind kinds. Core never becomes the pack.
 * Real Estate types do not live here.
 */
export interface PackIdentity {
  packId: string;
  name: string;
  version: string;
  owner: string;
  domain: string;
}

export interface PackRole {
  id: string;
  title: string;
  persona: string;
  skills: string[];
  specialties: string[];
  memoryScope: string;
}

export interface OrgSeat {
  seatId: string;
  roleId: string;
  agentName: string;
}

export interface OrgChart {
  seats: OrgSeat[];
}

export interface JourneyKind {
  id: string;
  label: string;
  stages: string[];
}

export interface ActionClassVerb {
  verb: string;
  class: string;
  externalEffect: boolean;
}

export interface PackPolicy {
  ruleRefs: string[];
  rules: PackPolicyRule[];
  defaultStance: "authorization";
  graduation: {
    requiresIndependentOutcomeEvidence: true;
    surpriseGraduationIsFailure: true;
  };
}

export interface PackPolicyRule {
  id: string;
  whenVerb: string;
  whenClass?: string | undefined;
  effect: "deny" | "require_authorization" | "allow_if_authorized";
  reason: string;
}

export interface PackConnector {
  id: string;
  kind: string;
  egressHosts: string[];
}

export interface KindBinding {
  id: string;
  label: string;
}

export interface PackBindings {
  recordKinds: KindBinding[];
  partyKinds: KindBinding[];
  knowledgeKinds: KindBinding[];
}

export interface EvidenceFixture {
  id: string;
  summary: string;
  independent: true;
}

export interface EvalFixture {
  id: string;
  name: string;
  mustPass: true;
  prompt: string;
  expectedStance: "refuse_unauthorized" | "follow_policy" | "no_assumed_autonomy";
}

export interface AskCeilings {
  maxTurns: number;
  maxExternalEffects: number;
  forbiddenVerbs: string[];
}

export interface PackSignatures {
  pack: Ed25519Signature;
  owner: Ed25519Signature;
}

export interface Ed25519Signature {
  alg: "Ed25519";
  publicKey: string;
  signature: string;
}

export interface PackDocument {
  identity: PackIdentity;
  roles: PackRole[];
  orgChart: OrgChart;
  journeyKinds: JourneyKind[];
  actionClassVerbs: ActionClassVerb[];
  policy: PackPolicy;
  connectors: PackConnector[];
  bindings: PackBindings;
  evidence: { fixtures: EvidenceFixture[] };
  eval: { fixtures: EvalFixture[] };
  askCeilings: AskCeilings;
  fieldLanguageMap: Record<string, string>;
  signatures: PackSignatures;
}

export const REQUIRED_PACK_SECTIONS = [
  "identity",
  "roles",
  "orgChart",
  "journeyKinds",
  "actionClassVerbs",
  "policy",
  "connectors",
  "bindings",
  "evidence",
  "eval",
  "askCeilings",
  "fieldLanguageMap",
] as const;

export type RequiredPackSection = (typeof REQUIRED_PACK_SECTIONS)[number];

export interface LoadedPack {
  tenantId: string;
  document: PackDocument;
  canonicalBytes: Buffer;
  loadedBy: string;
  loadedAt: Date;
}
