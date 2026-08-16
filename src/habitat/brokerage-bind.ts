import { chmodSync } from "node:fs";
import { computerRoot } from "../computer/paths.js";
import { AvError } from "../errors.js";
import { readJsonFileStrict, writeJsonAtomic } from "../persist/json-file.js";
import { verifyPayload, type TrustAnchors } from "../packs/signing.js";

/**
 * Counsel-signed brokerage rules on the tenant computer.
 * Same class as adapter-bind / connector-bind / cards: core-owned, beside
 * disk/, never a field file, never pack schema, never a createDeepAgent option.
 * A fixture, bundled default, or first-row fallback is not a bind.
 */
export interface BrokerageBindRecord {
  tenantId: string;
  /** Generic rules the tenant bound. Not RE journey types or pack nouns. */
  rules: unknown;
  boundBy: "architect";
  boundAt: string;
  signatures: {
    counselEval: string;
  };
}

export interface BrokerageUnsignedPayload {
  tenantId: string;
  rules: unknown;
}

const CREDENTIAL_KEYS = ["apiKey", "secret", "credential", "token", "password"] as const;

function unbound(message: string): never {
  throw new AvError("BROKERAGE_UNBOUND", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Counsel signs tenantId + rules. Architect write metadata is not in the payload. */
export function unsignedBrokeragePayload(tenantId: string, rules: unknown): BrokerageUnsignedPayload {
  return { tenantId, rules };
}

export function assertBrokerageRules(rules: unknown): unknown {
  if (Array.isArray(rules)) {
    if (rules.length === 0) {
      unbound("Brokerage bind is incomplete; refusing to invent rules");
    }
    return rules;
  }
  if (!isRecord(rules) || Object.keys(rules).length === 0) {
    unbound("Brokerage bind is incomplete; refusing to invent rules");
  }
  return rules;
}

export function brokerageFile(computerBaseDir: string, tenantId: string): string {
  return computerRoot(computerBaseDir, tenantId).brokerageFile;
}

export function saveBrokerageBind(file: string, record: BrokerageBindRecord): void {
  writeJsonAtomic(file, record);
  chmodSync(file, 0o600);
}

function parseBind(raw: unknown): BrokerageBindRecord {
  if (!isRecord(raw)) {
    unbound("Brokerage bind is incomplete; refusing to invent rules");
  }
  for (const key of CREDENTIAL_KEYS) {
    if (key in raw) {
      unbound("Provider credentials SHALL NOT live on brokerage.json");
    }
  }
  if (
    typeof raw.tenantId !== "string" ||
    !raw.tenantId.trim() ||
    raw.boundBy !== "architect" ||
    typeof raw.boundAt !== "string" ||
    !raw.boundAt.trim() ||
    !isRecord(raw.signatures) ||
    typeof raw.signatures.counselEval !== "string" ||
    !raw.signatures.counselEval.trim()
  ) {
    unbound("Brokerage bind is unsigned or incomplete; Architect must bind counsel-signed rules");
  }
  const rules = assertBrokerageRules(raw.rules);
  return {
    tenantId: raw.tenantId,
    rules,
    boundBy: "architect",
    boundAt: raw.boundAt,
    signatures: { counselEval: raw.signatures.counselEval },
  };
}

export function verifyBrokerageCounselSignature(
  record: Pick<BrokerageBindRecord, "tenantId" | "rules" | "signatures">,
  anchors: TrustAnchors,
): void {
  const payload = unsignedBrokeragePayload(record.tenantId, record.rules);
  if (!verifyPayload(payload, anchors.counselEvalPublicKeyPem, record.signatures.counselEval)) {
    unbound("Brokerage bind is unsigned or incomplete; Architect must bind counsel-signed rules");
  }
}

/**
 * Load tenants/{id}/brokerage.json and verify the counsel signature.
 * Missing, unsigned, incomplete, or tampered → BROKERAGE_UNBOUND.
 * Do not invent a bind from a fixture, pack, or first row.
 */
export function resolveBrokerageBind(
  computerBaseDir: string | undefined,
  tenantId: string,
  anchors: TrustAnchors,
): BrokerageBindRecord {
  if (!computerBaseDir) {
    unbound("Brokerage bind is missing; Architect must bind counsel-signed rules");
  }
  let raw: unknown;
  try {
    raw = readJsonFileStrict<unknown>(brokerageFile(computerBaseDir, tenantId));
  } catch {
    unbound("Brokerage bind is unsigned or incomplete; Architect must bind counsel-signed rules");
  }
  if (raw === undefined) {
    unbound("Brokerage bind is missing; Architect must bind counsel-signed rules");
  }
  const record = parseBind(raw);
  if (record.tenantId !== tenantId) {
    unbound("Brokerage bind is unsigned or incomplete; Architect must bind counsel-signed rules");
  }
  verifyBrokerageCounselSignature(record, anchors);
  return record;
}
