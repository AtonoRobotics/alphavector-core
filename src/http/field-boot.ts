import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PackLoadError } from "../errors.js";
import { DeepAgentsAdapter } from "../habitat/deep-agents.js";
import type { CognitiveAdapter } from "../habitat/types.js";
import { AlphaVectorCore } from "../kernel.js";
import type { LoadedPack, PackBinding } from "../packs/types.js";
import type { TrustAnchors } from "../packs/signing.js";
import { resolveProductTrustAnchors } from "../packs/trust-anchors.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLED_PACK = path.join(REPO_ROOT, "fixtures/packs/alphavector-re/pack.json");

export interface BootFieldCoreOptions {
  /** Tenant computer root core owns. Cards, facts, and records persist beside disk/, not in a pack. */
  computerBaseDir?: string;
  /**
   * Cognitive adapter. Omit for the product default DeepAgentsAdapter
   * (requires an Architect bind and Architect-written provider credentials;
   * think is live HTTP to the hosted model, not a canned fixture).
   * DryStemAdapter is fixture-only — pass it explicitly in eval / envelope tests.
   * An explicit thinkFn on DeepAgentsAdapter is the CI double, not the product default.
   */
  adapter?: CognitiveAdapter;
  /** Injectable habitat clock. Tests advance this; product uses wall time. */
  now?: () => string;
  /** Test override of the core-owned due interval. Not field-configured. */
  tickMs?: number;
  /**
   * Trust anchors the process did not generate. Tests pass a fixture keypair
   * created outside this function. Product boot resolves file or env instead.
   */
  anchors?: TrustAnchors;
  /**
   * Already-signed pack. Tests sign outside this function.
   * Product loads AV_PACK_PATH or the bundled fixture (unsigned fixture fails closed).
   */
  binding?: PackBinding;
  /** Signed pack file. Product: AV_PACK_PATH. */
  packPath?: string;
  /** Env for product anchor/pack resolution. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

async function loadBootBinding(packPath: string | undefined): Promise<PackBinding> {
  const file = packPath?.trim() ? packPath : BUNDLED_PACK;
  try {
    return JSON.parse(await readFile(file, "utf8")) as PackBinding;
  } catch {
    throw new PackLoadError("PACK_REFUSED", "Boot pack is unreadable");
  }
}

/** Boot a core with a pack signed by configured trust anchors. Architect load is internal, not a field route. */
export async function bootFieldCore(
  tenantId = "t1",
  opts: BootFieldCoreOptions = {},
): Promise<{
  core: AlphaVectorCore;
  pack: LoadedPack;
  tenantId: string;
}> {
  const env = opts.env ?? process.env;
  const anchors = opts.anchors ?? resolveProductTrustAnchors(env);
  const binding = opts.binding ?? (await loadBootBinding(opts.packPath ?? env.AV_PACK_PATH));
  const stateDir = opts.computerBaseDir ? path.join(opts.computerBaseDir, "state") : undefined;
  const core = new AlphaVectorCore(
    anchors,
    stateDir,
    opts.computerBaseDir,
    { adapter: opts.adapter ?? new DeepAgentsAdapter(), now: opts.now, tickMs: opts.tickMs },
  );
  const loaded = core.packs.load({ tenantId, binding, actor: "architect" });
  if (!loaded.ok) {
    throw new PackLoadError(loaded.code, loaded.message);
  }
  if (core.agents.list(tenantId).length === 0) {
    core.agents.instantiateFromPack(loaded.loaded, "architect");
  }
  core.habitat.setPack(tenantId, loaded.loaded);
  if (opts.computerBaseDir) {
    core.habitat.startDueTicker();
  }
  return { core, pack: loaded.loaded, tenantId };
}

export function fieldLinuxPagePath(): string {
  return path.join(REPO_ROOT, "clients/field-linux/index.html");
}
