import { PackLoadError } from "../errors.js";
import {
  REQUIRED_PACK_SECTIONS,
  type PackBinding,
  type PackSection,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOptionalPredicateLists(raw: Record<string, unknown>, label: string): void {
  for (const key of ["REQUIRES", "PREFERS", "AVOIDS"] as const) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key]) || raw[key].some((item) => typeof item !== "string")) {
      throw new PackLoadError("PACK_INCOMPLETE", `${label}.${key} must be a string array when present`);
    }
  }
}

function missingSections(raw: Record<string, unknown>): PackSection[] {
  return REQUIRED_PACK_SECTIONS.filter((section) => raw[section] === undefined);
}

export function assertCompletePack(raw: unknown): PackBinding {
  if (!isRecord(raw)) {
    throw new PackLoadError("PACK_INCOMPLETE", "Pack binding must be an object");
  }
  const missing = missingSections(raw);
  if (missing.length > 0) {
    throw new PackLoadError(
      "PACK_INCOMPLETE",
      `Pack missing required sections: ${missing.join(", ")}`,
    );
  }

  const identity = raw.identity;
  if (!isRecord(identity) || !identity.packId || !identity.version || !identity.displayName) {
    throw new PackLoadError("PACK_INCOMPLETE", "identity requires packId, version, displayName");
  }
  if (!Array.isArray(raw.roles)) {
    throw new PackLoadError("PACK_INCOMPLETE", "roles must be an array");
  }
  if (raw.roles.length === 0) {
    throw new PackLoadError("PACK_INCOMPLETE", "roles array is required and must not be empty");
  }
  for (const role of raw.roles) {
    if (!isRecord(role) || typeof role.name !== "string" || !role.name.trim()) {
      throw new PackLoadError("PACK_INCOMPLETE", "each role requires a name");
    }
    if (typeof role.persona !== "string") {
      throw new PackLoadError("PACK_INCOMPLETE", `role ${role.name} requires a persona`);
    }
    if (!Array.isArray(role.skills) || !Array.isArray(role.specialties)) {
      throw new PackLoadError("PACK_INCOMPLETE", `role ${role.name} requires skills and specialties arrays`);
    }
  }
  if (!Array.isArray(raw.journeyKinds) || raw.journeyKinds.length === 0) {
    throw new PackLoadError("PACK_INCOMPLETE", "journeyKinds must be a non-empty array");
  }
  for (const journey of raw.journeyKinds) {
    if (!isRecord(journey) || typeof journey.id !== "string") {
      throw new PackLoadError("PACK_INCOMPLETE", "journeyKinds require id");
    }
    assertOptionalPredicateLists(journey, `journeyKinds.${journey.id}`);
  }
  if (!Array.isArray(raw.actionClassVerbs) || raw.actionClassVerbs.length === 0) {
    throw new PackLoadError("PACK_INCOMPLETE", "actionClassVerbs must be a non-empty array");
  }
  for (const verb of raw.actionClassVerbs) {
    if (!isRecord(verb) || typeof verb.id !== "string") {
      throw new PackLoadError("PACK_INCOMPLETE", "actionClassVerbs require id");
    }
    if ("tier" in verb || "trustTier" in verb || "t0" in verb || "T0" in verb) {
      throw new PackLoadError("PACK_INVALID", "DEC-017 is not accepted; do not invent T0-T3 numbers");
    }
    assertOptionalPredicateLists(verb, `actionClassVerbs.${verb.id}`);
  }

  const policy = raw.policy;
  if (!isRecord(policy)) {
    throw new PackLoadError("PACK_INCOMPLETE", "policy must be an object");
  }
  for (const key of ["jurisdiction", "licensedAction", "consent", "adversarialFixtures"] as const) {
    if (!Array.isArray(policy[key])) {
      throw new PackLoadError("PACK_INCOMPLETE", `policy.${key} is required`);
    }
  }
  if ((policy.adversarialFixtures as unknown[]).length === 0) {
    throw new PackLoadError("PACK_INCOMPLETE", "policy.adversarialFixtures are required");
  }

  if (!Array.isArray(raw.connectors)) {
    throw new PackLoadError("PACK_INCOMPLETE", "connectors must be an array");
  }
  const rpk = raw.recordPartyKnowledge;
  if (!isRecord(rpk)) {
    throw new PackLoadError("PACK_INCOMPLETE", "recordPartyKnowledge is required");
  }
  for (const key of [
    "partyKinds",
    "recordKinds",
    "predicates",
    "corpora",
    "graphNodeKinds",
    "graphEdgeKinds",
  ] as const) {
    if (!Array.isArray(rpk[key])) {
      throw new PackLoadError("PACK_INCOMPLETE", `recordPartyKnowledge.${key} is required`);
    }
  }
  if (!Array.isArray(raw.evidenceEvalFixtures) || raw.evidenceEvalFixtures.length === 0) {
    throw new PackLoadError("PACK_INCOMPLETE", "evidenceEvalFixtures are required");
  }
  if (!Array.isArray(raw.askCeilings)) {
    throw new PackLoadError("PACK_INCOMPLETE", "askCeilings must be an array");
  }
  if (!isRecord(raw.fieldLanguageMap)) {
    throw new PackLoadError("PACK_INCOMPLETE", "fieldLanguageMap is required");
  }

  return raw as unknown as PackBinding;
}

export function unsignedPayload(binding: PackBinding): Omit<PackBinding, "signatures"> {
  const { signatures: _ignored, ...rest } = binding;
  return rest;
}
