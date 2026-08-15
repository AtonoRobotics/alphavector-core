import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AlphaVectorCore } from "../kernel.js";
import type { LoadedPack, PackBinding } from "../packs/types.js";
import { generateEd25519, signPack } from "../packs/signing.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Boot a core with the pinned alphavector-re fixture. Architect load is internal, not a field route. */
export async function bootFieldCore(tenantId = "t1"): Promise<{
  core: AlphaVectorCore;
  pack: LoadedPack;
  tenantId: string;
}> {
  const unsigned = JSON.parse(
    await readFile(path.join(REPO_ROOT, "fixtures/packs/alphavector-re/pack.json"), "utf8"),
  ) as Omit<PackBinding, "signatures">;
  const architect = generateEd25519();
  const counsel = generateEd25519();
  const binding = signPack(unsigned, architect.privateKeyPem, counsel.privateKeyPem);
  const core = new AlphaVectorCore({
    architectPublicKeyPem: architect.publicKeyPem,
    counselEvalPublicKeyPem: counsel.publicKeyPem,
  });
  const loaded = core.packs.load({ tenantId, binding, actor: "architect" });
  if (!loaded.ok) {
    throw new Error(`Field boot failed to load pack: ${loaded.message}`);
  }
  core.agents.instantiateFromPack(loaded.loaded, "architect");
  return { core, pack: loaded.loaded, tenantId };
}

export function fieldLinuxPagePath(): string {
  return path.join(REPO_ROOT, "clients/field-linux/index.html");
}
