import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { canonicalJson } from "../ids.js";
import { PackLoadError } from "../errors.js";
import type { LoadedPack, PackBinding, PackSignatures } from "./types.js";
import { assertCompletePack, unsignedPayload } from "./schema.js";

export interface Ed25519KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateEd25519(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signPayload(payload: unknown, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(canonicalJson(payload)), key);
  return sig.toString("base64");
}

export function verifyPayload(payload: unknown, publicKeyPem: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export interface TrustAnchors {
  architectPublicKeyPem: string;
  counselEvalPublicKeyPem: string;
}

export function signPack(
  binding: Omit<PackBinding, "signatures">,
  architectPrivateKeyPem: string,
  counselPrivateKeyPem: string,
): PackBinding {
  const payload = unsignedPayload(binding as PackBinding);
  const signatures: PackSignatures = {
    architect: signPayload(payload, architectPrivateKeyPem),
    counselEval: signPayload(payload, counselPrivateKeyPem),
  };
  return { ...payload, signatures };
}

export function verifyPackSignatures(binding: PackBinding, anchors: TrustAnchors): void {
  if (!binding.signatures) {
    throw new PackLoadError("PACK_UNSIGNED", "Unsigned pack refused");
  }
  if (!binding.signatures.architect) {
    throw new PackLoadError("PACK_UNSIGNED_OWNER", "Architect signature missing");
  }
  if (!binding.signatures.counselEval) {
    throw new PackLoadError("PACK_UNSIGNED_OWNER", "Counsel/eval signature missing");
  }
  const payload = unsignedPayload(binding);
  if (!verifyPayload(payload, anchors.architectPublicKeyPem, binding.signatures.architect)) {
    throw new PackLoadError("PACK_UNSIGNED_OWNER", "Architect signature invalid");
  }
  if (!verifyPayload(payload, anchors.counselEvalPublicKeyPem, binding.signatures.counselEval)) {
    throw new PackLoadError("PACK_UNSIGNED_OWNER", "Counsel/eval signature invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Re-verify a persisted active pack against trust anchors (DEC-019).
 * Incomplete, unsigned, or unsigned-owner records fail closed.
 */
export function assertVerifiedLoadedPack(
  raw: unknown,
  anchors: TrustAnchors,
  expectedTenantId?: string,
): LoadedPack {
  if (!isRecord(raw)) {
    throw new PackLoadError("PACK_INCOMPLETE", "Active pack record must be an object");
  }
  if (typeof raw.tenantId !== "string" || !raw.tenantId.trim()) {
    throw new PackLoadError("PACK_INCOMPLETE", "Active pack record requires tenantId");
  }
  if (expectedTenantId !== undefined && raw.tenantId !== expectedTenantId) {
    throw new PackLoadError("PACK_REFUSED", "Active pack tenant does not match");
  }
  if (raw.loadedBy !== "architect") {
    throw new PackLoadError("PACK_UNSIGNED_OWNER", "Active pack owner is not architect");
  }
  if (typeof raw.loadedAt !== "string" || !raw.loadedAt.trim()) {
    throw new PackLoadError("PACK_INCOMPLETE", "Active pack record requires loadedAt");
  }
  const binding = assertCompletePack(raw.binding);
  verifyPackSignatures(binding, anchors);
  return {
    tenantId: raw.tenantId,
    binding,
    loadedAt: raw.loadedAt,
    loadedBy: "architect",
  };
}
