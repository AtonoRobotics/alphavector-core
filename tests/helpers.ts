import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signPack, generateEd25519, type TrustAnchors } from "../src/packs/signing.js";
import type { PackBinding } from "../src/packs/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Pinned AtonoRobotics/alphavector-re commit for the first RE slice fixture. */
export const ALPHAVECTOR_RE_PIN_SHA = "9acf9ce47976b9bbd74a189f6fdc8cbb8940e841";

export async function loadGenericUnsigned(): Promise<Omit<PackBinding, "signatures">> {
  const raw = JSON.parse(
    await readFile(path.join(root, "fixtures/packs/generic/pack.json"), "utf8"),
  ) as Omit<PackBinding, "signatures">;
  return raw;
}

export async function loadReUnsigned(): Promise<Omit<PackBinding, "signatures">> {
  const raw = JSON.parse(
    await readFile(path.join(root, "fixtures/packs/alphavector-re/pack.json"), "utf8"),
  ) as Omit<PackBinding, "signatures">;
  return raw;
}

export function makeAnchors(): {
  anchors: TrustAnchors;
  architectPrivate: string;
  counselPrivate: string;
} {
  const architect = generateEd25519();
  const counsel = generateEd25519();
  return {
    anchors: {
      architectPublicKeyPem: architect.publicKeyPem,
      counselEvalPublicKeyPem: counsel.publicKeyPem,
    },
    architectPrivate: architect.privateKeyPem,
    counselPrivate: counsel.privateKeyPem,
  };
}

export async function signedGenericPack(): Promise<{
  binding: PackBinding;
  anchors: TrustAnchors;
}> {
  const unsigned = await loadGenericUnsigned();
  const keys = makeAnchors();
  return {
    binding: signPack(unsigned, keys.architectPrivate, keys.counselPrivate),
    anchors: keys.anchors,
  };
}

export async function signedRePack(): Promise<{
  binding: PackBinding;
  anchors: TrustAnchors;
}> {
  const unsigned = await loadReUnsigned();
  const keys = makeAnchors();
  return {
    binding: signPack(unsigned, keys.architectPrivate, keys.counselPrivate),
    anchors: keys.anchors,
  };
}

export const REPO_ROOT = root;
