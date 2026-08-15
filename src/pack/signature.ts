import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { canonicalPackBytes, stripSignatures } from "./canonical.js";
import { PackLoadError } from "./errors.js";
import type { Ed25519Signature, PackDocument } from "./types.js";

export interface Ed25519KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

export function signBytes(privateKeyB64: string, bytes: Buffer): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, bytes, key).toString("base64");
}

export function verifyBytes(publicKeyB64: string, bytes: Buffer, signatureB64: string): boolean {
  const key = createPublicKey({
    key: Buffer.from(publicKeyB64, "base64"),
    format: "der",
    type: "spki",
  });
  return verify(null, bytes, key, Buffer.from(signatureB64, "base64"));
}

export function packPayloadBytes(document: unknown): Buffer {
  return canonicalPackBytes(stripSignatures(document));
}

export function ownerPayloadBytes(owner: string, packPayload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`owner:${owner}\n`, "utf8"), packPayload]);
}

export function signPackDocument(
  unsigned: Omit<PackDocument, "signatures">,
  packKey: Ed25519KeyPair,
  ownerKey: Ed25519KeyPair,
): PackDocument {
  const payload = packPayloadBytes(unsigned);
  const packSig: Ed25519Signature = {
    alg: "Ed25519",
    publicKey: packKey.publicKey,
    signature: signBytes(packKey.privateKey, payload),
  };
  const ownerSig: Ed25519Signature = {
    alg: "Ed25519",
    publicKey: ownerKey.publicKey,
    signature: signBytes(ownerKey.privateKey, ownerPayloadBytes(unsigned.identity.owner, payload)),
  };
  return {
    ...unsigned,
    signatures: { pack: packSig, owner: ownerSig },
  };
}

export function verifyPackSignatures(document: PackDocument): void {
  const payload = packPayloadBytes(document);
  if (document.signatures.pack.alg !== "Ed25519" || document.signatures.owner.alg !== "Ed25519") {
    throw new PackLoadError("PACK_UNSIGNED", "Pack signatures must be Ed25519.");
  }
  if (!document.signatures.pack.signature || !document.signatures.pack.publicKey) {
    throw new PackLoadError("PACK_UNSIGNED", "Pack signature is missing.");
  }
  if (!document.signatures.owner.signature || !document.signatures.owner.publicKey) {
    throw new PackLoadError("PACK_OWNER_UNSIGNED", "Owner signature is missing.");
  }
  const packOk = verifyBytes(document.signatures.pack.publicKey, payload, document.signatures.pack.signature);
  if (!packOk) {
    throw new PackLoadError("PACK_UNSIGNED", "Pack signature is invalid.");
  }
  const ownerOk = verifyBytes(
    document.signatures.owner.publicKey,
    ownerPayloadBytes(document.identity.owner, payload),
    document.signatures.owner.signature,
  );
  if (!ownerOk) {
    throw new PackLoadError("PACK_OWNER_UNSIGNED", "Owner signature is invalid.");
  }
}
