import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { Journey } from "../src/data/types.js";
import { AvError } from "../src/errors.js";
import type { FactBook } from "../src/facts/book.js";
import type { FieldClient } from "../src/http/field-client.js";
import type { FieldApproveResult } from "../src/http/types.js";
import { signPack, generateEd25519, type TrustAnchors } from "../src/packs/signing.js";
import type { PackBinding } from "../src/packs/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Pinned AtonoRobotics/alphavector-re commit for the first RE slice fixture. */
export const ALPHAVECTOR_RE_PIN_SHA = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";

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

/** Sign a copy of the pinned RE fixture after attaching generic declarations. */
export async function signedRePackMutated(
  mutate: (unsigned: Omit<PackBinding, "signatures">) => void,
): Promise<{
  binding: PackBinding;
  anchors: TrustAnchors;
}> {
  const unsigned = await loadReUnsigned();
  mutate(unsigned);
  const keys = makeAnchors();
  return {
    binding: signPack(unsigned, keys.architectPrivate, keys.counselPrivate),
    anchors: keys.anchors,
  };
}

export const REPO_ROOT = root;

/** Missing/blank recordId on FactBook must fail closed — no tenant-global bucket. */
export function expectPresentIdsDeniedWithoutRecord(book: FactBook, tenantId: string): void {
  expect(() => book.presentIds(tenantId, undefined as unknown as string)).toThrow(AvError);
  expect(() => book.presentIds(tenantId, undefined as unknown as string)).toThrow(
    /Record id is required/,
  );
  expect(() => book.presentIds(tenantId, "")).toThrow(/Record id is required/);
}

/** Create a pack record, Open the kind on it, then start about it. */
export async function createOpenStart(
  field: FieldClient,
  kindId: string,
  objective: string,
  label = "Subject",
): Promise<{
  record: NonNullable<FieldApproveResult["record"]>;
  fact: NonNullable<FieldApproveResult["fact"]>;
  journey: Journey;
}> {
  const home = await field.home();
  const type = home.recordKinds[0]?.id ?? "record";
  const record = await field.createApprovedRecord(type, label);
  const fact = await field.openApproved(kindId, record.id);
  const journey = await field.start(kindId, objective, record.id);
  return { record, fact, journey };
}
