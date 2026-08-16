import { readFileSync } from "node:fs";
import { TrustAnchorError } from "../errors.js";
import type { TrustAnchors } from "./signing.js";

const ANCHOR_FILE_ENV = "AV_TRUST_ANCHORS_FILE";
const ARCHITECT_PEM_ENV = "AV_ARCHITECT_PUBLIC_KEY";
const ARCHITECT_FILE_ENV = "AV_ARCHITECT_PUBLIC_KEY_FILE";
const COUNSEL_PEM_ENV = "AV_COUNSEL_EVAL_PUBLIC_KEY";
const COUNSEL_FILE_ENV = "AV_COUNSEL_EVAL_PUBLIC_KEY_FILE";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN") && trimmed.includes("\\n")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  return trimmed;
}

function readPemFile(file: string, label: string): string {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new TrustAnchorError("TRUST_ANCHORS_INVALID", `${label} trust-anchor file is unreadable`);
  }
  const pem = normalizePem(raw);
  if (!pem) {
    throw new TrustAnchorError("TRUST_ANCHORS_INVALID", `${label} trust-anchor file is empty`);
  }
  return pem;
}

function readPemFromEnv(
  env: NodeJS.ProcessEnv,
  pemKey: string,
  fileKey: string,
  label: string,
): string | undefined {
  const file = env[fileKey]?.trim();
  if (file) return readPemFile(file, label);
  const inline = env[pemKey];
  if (inline === undefined) return undefined;
  const pem = normalizePem(inline);
  return pem || undefined;
}

function readAnchorsJsonFile(file: string): TrustAnchors {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new TrustAnchorError("TRUST_ANCHORS_INVALID", "Trust-anchor file is unreadable");
  }
  if (!isRecord(raw)) {
    throw new TrustAnchorError("TRUST_ANCHORS_INVALID", "Trust-anchor file must be an object");
  }
  const architect =
    typeof raw.architectPublicKeyPem === "string" ? normalizePem(raw.architectPublicKeyPem) : "";
  const counsel =
    typeof raw.counselEvalPublicKeyPem === "string" ? normalizePem(raw.counselEvalPublicKeyPem) : "";
  if (!architect || !counsel) {
    throw new TrustAnchorError(
      "TRUST_ANCHORS_INVALID",
      "Trust-anchor file requires architectPublicKeyPem and counselEvalPublicKeyPem",
    );
  }
  return {
    architectPublicKeyPem: architect,
    counselEvalPublicKeyPem: counsel,
  };
}

/**
 * Product trust anchors (DEC-019 / CS-093). File or env the process does not generate.
 * Missing or blank anchors fail closed. No generated self-signed fallback.
 */
export function resolveProductTrustAnchors(env: NodeJS.ProcessEnv = process.env): TrustAnchors {
  const anchorsFile = env[ANCHOR_FILE_ENV]?.trim();
  if (anchorsFile) return readAnchorsJsonFile(anchorsFile);

  const architect = readPemFromEnv(env, ARCHITECT_PEM_ENV, ARCHITECT_FILE_ENV, "Architect");
  const counsel = readPemFromEnv(env, COUNSEL_PEM_ENV, COUNSEL_FILE_ENV, "Counsel/eval");
  if (!architect && !counsel) {
    throw new TrustAnchorError(
      "TRUST_ANCHORS_MISSING",
      "Trust anchors are not configured (file or env). Product boot does not generate signing keys.",
    );
  }
  if (!architect || !counsel) {
    throw new TrustAnchorError(
      "TRUST_ANCHORS_MISSING",
      "Both architect and counsel/eval trust anchors are required",
    );
  }
  return {
    architectPublicKeyPem: architect,
    counselEvalPublicKeyPem: counsel,
  };
}
