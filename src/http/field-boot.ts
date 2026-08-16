import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CognitiveAdapter } from "../habitat/types.js";
import { AlphaVectorCore } from "../kernel.js";
import type { LoadedPack, PackBinding } from "../packs/types.js";
import { generateEd25519, signPack } from "../packs/signing.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface BootFieldCoreOptions {
  /** Tenant computer root core owns. Cards, facts, and records persist beside disk/, not in a pack. */
  computerBaseDir?: string;
  /** Cognitive adapter. Omit to keep DryStem (eval / existing envelope). */
  adapter?: CognitiveAdapter;
}

/** Boot a core with the pinned alphavector-re fixture. Architect load is internal, not a field route. */
export async function bootFieldCore(
  tenantId = "t1",
  opts: BootFieldCoreOptions = {},
): Promise<{
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
  const stateDir = opts.computerBaseDir ? path.join(opts.computerBaseDir, "state") : undefined;
  const core = new AlphaVectorCore(
    {
      architectPublicKeyPem: architect.publicKeyPem,
      counselEvalPublicKeyPem: counsel.publicKeyPem,
    },
    stateDir,
    opts.computerBaseDir,
    { adapter: opts.adapter },
  );
  const loaded = core.packs.load({ tenantId, binding, actor: "architect" });
  if (!loaded.ok) {
    throw new Error(`Field boot failed to load pack: ${loaded.message}`);
  }
  if (core.agents.list(tenantId).length === 0) {
    core.agents.instantiateFromPack(loaded.loaded, "architect");
  }
  return { core, pack: loaded.loaded, tenantId };
}

export function fieldLinuxPagePath(): string {
  return path.join(REPO_ROOT, "clients/field-linux/index.html");
}
